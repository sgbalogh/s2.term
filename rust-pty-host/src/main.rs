use clap::Parser;
use eyre::eyre;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use s2::batching::{AppendRecordsBatchingOpts, AppendRecordsBatchingStream};
use s2::client::S2Endpoints;
use s2::types::{
    AppendRecord, BasinName, Header, ReadOutput, ReadSessionRequest, ReadStart, SequencedRecord,
    StreamPosition,
};
use s2::{ClientConfig, StreamClient};
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tracing::{error, trace};

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Args {
    basin: String,
    session: String,
    #[arg(long)]
    process: String,
}

enum Input {
    Keystroke(Vec<u8>),
    WindowResize { rows: u16, cols: u16 },
}

impl TryFrom<SequencedRecord> for Input {
    type Error = eyre::Report;

    fn try_from(value: SequencedRecord) -> Result<Self, Self::Error> {
        let type_header = value.headers.first().ok_or(eyre!("no headers"))?;
        if type_header.name != "type" {
            return Err(eyre!("first header does not contain type"));
        }
        let type_value = String::from_utf8(type_header.value.to_vec())?;
        match type_value.as_ref() {
            "keystroke" => Ok(Input::Keystroke(value.body.to_vec())),
            "window" => {
                let Header {
                    name,
                    value: header_value,
                } = value.headers.get(1).ok_or(eyre!("missing rows header"))?;
                let rows = if name == "rows" {
                    String::from_utf8(header_value.to_vec())?
                        .as_str()
                        .parse::<u16>()?
                } else {
                    return Err(eyre!("missing rows value"));
                };
                let Header {
                    name,
                    value: header_value,
                } = value.headers.get(2).ok_or(eyre!("missing cols header"))?;
                let cols = if name == "cols" {
                    String::from_utf8(header_value.to_vec())?
                        .as_str()
                        .parse::<u16>()?
                } else {
                    return Err(eyre!("missing cols value"));
                };
                Ok(Input::WindowResize { rows, cols })
            }
            _ => Err(eyre!("unrecognized type")),
        }
    }
}

/// Get current timestamp in ms.
fn timestamp_now() -> u64 {
    let now = SystemTime::now();
    now.duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_millis() as u64
}

#[tokio::main]
async fn main() -> eyre::Result<()> {
    tracing_subscriber::fmt::init();
    let pty_system = native_pty_system();

    let args = Args::parse();

    let pair = pty_system
        .openpty(PtySize {
            rows: 32,
            cols: 72,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| eyre!(e))?;

    let cmd = CommandBuilder::new(args.process);
    let _child = pair.slave.spawn_command(cmd).map_err(|e| eyre!(e))?;

    // Obtain a reader and writer for the PTY master
    let reader = pair.master.try_clone_reader().map_err(|e| eyre!(e))?;
    let mut writer = pair.master.take_writer().map_err(|e| eyre!(e))?;

    let input_stream = format!("sessions/{}/term_input", args.session);
    let output_stream = format!("sessions/{}/term_output", args.session);

    // Note that we always start from the current tail of the input stream.
    let mut keystrokes = StreamClient::new(
        ClientConfig::new(std::env::var("S2_ACCESS_TOKEN")?)
            .with_endpoints(S2Endpoints::from_env().map_err(|msg| eyre!(msg))?),
        BasinName::try_from(args.basin.clone())?,
        input_stream,
    )
    .read_session(ReadSessionRequest::new(ReadStart::TailOffset(0)))
    .await?;

    let (append_tx, append_rx) = mpsc::unbounded_channel();

    let output_client = StreamClient::new(
        ClientConfig::new(std::env::var("S2_ACCESS_TOKEN")?)
            .with_endpoints(S2Endpoints::from_env().map_err(|msg| eyre!(msg))?),
        BasinName::try_from(args.basin)?,
        output_stream,
    );

    // Get the current tail of the output stream, and use that for `match_seq_num`.
    let StreamPosition { seq_num, .. } = output_client.check_tail().await?;

    // Configure a batching stream.
    // This is not strictly necessary, but `with_match_seq_num` gives us protection against duplicates.
    let batching_opts = AppendRecordsBatchingOpts::new()
        .with_max_batch_records(1000)
        .with_linger(Duration::from_millis(0))
        .with_match_seq_num(Some(seq_num));

    let mut append = output_client
        .append_session(AppendRecordsBatchingStream::new(
            UnboundedReceiverStream::new(append_rx),
            batching_opts,
        ))
        .await?;

    // Spawn a task to consume from the PTY reader.
    // The `read` fn blocks, so this needs to happen in its own task.
    // Whenever a read finishes, we communicate it via mpsc channel.
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 1024 * 10];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    if tx.send(data).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    error!(?e, "read error");
                    break;
                }
            }
        }
    });

    'outer: loop {
        tokio::select! {

            // Handle messages from the input stream.
            Some(msg) = keystrokes.next() => {
                let msg = msg?;
                if let ReadOutput::Batch(batch) = msg {
                    for record in batch.records {
                        match Input::try_from(record)? {
                            Input::Keystroke(key) => {
                                trace!(?key, "keystroke");
                                let write: Result<(), eyre::Report> = (|| {
                                    writer.write_all(key.as_slice())?;
                                    writer.flush()?;
                                    Ok(())
                                })();
                                if let Err(e) = write {
                                    error!(?e);
                                    break 'outer;
                                }
                            },
                            Input::WindowResize { rows, cols } => {
                                trace!(?rows, ?cols, "window resize");
                                pair.master.resize(PtySize {
                                    rows,
                                    cols,
                                    pixel_width: 0,
                                    pixel_height: 0
                                }).map_err(|e| eyre!(e))?;
                            }
                        }
                    }
                }
            }

            // Handle PTY output.
            Some(msg) = rx.recv() => {
                let content = String::from_utf8_lossy(&msg);
                trace!(?content);
                let record = AppendRecord::new(msg)?.with_timestamp(timestamp_now()).with_headers([Header::new("type", "out")])?;
                append_tx.send(record)?;
            }

            // Acknowledgements from appends to the output stream.
            Some(ack) = append.next() => {
                let ack = ack?;
                trace!(?ack);
            }

            else => {
                break;
            }
        }
    }

    append_tx.send(
        AppendRecord::new("\r\n\x1b[31mserver crashed :-!\x1b[0m\r")?
            .with_timestamp(timestamp_now())
            .with_headers([Header::new("type", "out")])?,
    )?;

    Ok(())
}
