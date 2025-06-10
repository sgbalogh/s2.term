import {Terminal} from "@xterm/xterm";
import {FitAddon} from "@xterm/addon-fit";
import {WebLinksAddon} from "@xterm/addon-web-links";
import {S2} from "@s2-dev/streamstore";
import {ReadAcceptEnum} from "@s2-dev/streamstore/funcs/recordsRead";
import {
    ReadEvent,
    Batch,
    SequencedRecord,
} from "@s2-dev/streamstore/models/components";

enum SetupState {
    GREETING,
    COLLECTING_BASIN,
    COLLECTING_SESSION,
    COLLECTING_TOKEN,
    TESTING_CONNECTION,
    STREAMING
}

class StreamingTerminal {
    private terminal: Terminal;
    private fitAddon: FitAddon;
    private basin!: string;
    private sessionNumber!: string;
    private token!: string;
    private s2!: S2;
    private setupState: SetupState = SetupState.GREETING;
    private currentInput: string = "";
    private keystrokes_stream!: string;
    private pty_stream!: string;
    private since?: number;
    private speedup: number = 1;
    private lastRecordTimestamp?: number;
    private isLiveMode: boolean = false;

    constructor() {
        this.terminal = new Terminal({
            cursorBlink: true,
            fontSize: 20,
            fontFamily: 'Consolas, "Courier New", monospace',
            theme: {
                background: "#000000",
                foreground: "#ffffff",
                cursor: "#d4d4d4",
                selectionBackground: "#264f78",
            },
        });

        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(new WebLinksAddon());

        this.setupEventHandlers();
    }

    public async initialize(): Promise<void> {
        const container = document.getElementById("terminal");
        if (!container) {
            throw new Error("Terminal container not found");
        }

        this.terminal.open(container);
        this.fitAddon.fit();

        // Handle window resize
        window.addEventListener("resize", () => {
            this.fitAddon.fit();
        });

        // Start the interactive setup flow
        await this.startSetupFlow();
    }

    private async startSetupFlow(): Promise<void> {
        await this.writelnAsync("s2.term 🌊");
        await this.writelnAsync("");

        // Check for query parameters first
        const urlParams = new URLSearchParams(window.location.search);
        const basinParam = urlParams.get("basin");
        const sessionParam = urlParams.get("session");
        const tokenParam = urlParams.get("token");
        const sinceParam = urlParams.get("since");
        const speedupParam = urlParams.get("speedup");

        if (basinParam && sessionParam && tokenParam) {
            // Use query params and skip interactive flow
            this.basin = basinParam;
            this.sessionNumber = sessionParam;
            this.token = tokenParam;
            this.since = sinceParam ? parseInt(sinceParam) : undefined;
            this.speedup = speedupParam ? parseFloat(speedupParam) : 1;
            this.keystrokes_stream = `sessions/${this.sessionNumber}/term_input`;
            this.pty_stream = `sessions/${this.sessionNumber}/term_output`;

            await this.writelnAsync(`Using basin: ${this.basin}`);
            await this.writelnAsync(`Using session: ${this.sessionNumber}`);
            if (this.since) {
                await this.writelnAsync(`Starting from timestamp: ${this.since} (${new Date(this.since).toISOString()})`);
                await this.writelnAsync(`Speedup: ${this.speedup}x`);
            }
            await this.writelnAsync("Testing S2 connection...");

            this.setupState = SetupState.TESTING_CONNECTION;
            await this.testS2Connection();
        } else {
            // Start interactive flow
            this.setupState = SetupState.COLLECTING_BASIN;
            await this.writelnAsync("Please enter basin name: ");
            await this.writeAsync("% ");
        }
    }

    private setupEventHandlers(): void {
        this.terminal.onData(async (data: string) => {
            if (this.setupState === SetupState.STREAMING) {
                await this.sendKeystroke(data);
            } else {
                await this.handleSetupInput(data);
            }
        });

        this.terminal.onResize(({cols, rows}) => {
            console.log(`Terminal resized to ${cols}x${rows}`);
            if (this.setupState === SetupState.STREAMING) {
                this.sendWindowResize(cols, rows);
            }
        });
    }

    private async handleSetupInput(data: string): Promise<void> {
        if (data === '\r') { // Enter key
            await this.writelnAsync("");
            await this.processSetupInput(this.currentInput.trim());
            this.currentInput = "";
        } else if (data === '\u007F') { // Backspace
            if (this.currentInput.length > 0) {
                this.currentInput = this.currentInput.slice(0, -1);
                await this.writeAsync('\b \b');
            }
        } else if (data >= ' ' && data <= '~') { // Printable characters
            this.currentInput += data;
            await this.writeAsync(data);
        }
    }

    private async processSetupInput(input: string): Promise<void> {
        switch (this.setupState) {
            case SetupState.COLLECTING_BASIN:
                this.basin = input;
                this.setupState = SetupState.COLLECTING_SESSION;
                await this.writelnAsync("Please enter session number: ");
                await this.writeAsync("% ");
                break;

            case SetupState.COLLECTING_SESSION:
                this.sessionNumber = input;
                this.keystrokes_stream = `sessions/${this.sessionNumber}/term_input`;
                this.pty_stream = `sessions/${this.sessionNumber}/term_output`;
                this.setupState = SetupState.COLLECTING_TOKEN;
                await this.writelnAsync("Please enter S2 token: ");
                await this.writeAsync("% ");
                break;

            case SetupState.COLLECTING_TOKEN:
                this.token = input;
                this.setupState = SetupState.TESTING_CONNECTION;
                await this.writelnAsync("Testing S2 connection...");
                await this.testS2Connection();
                break;
        }
    }

    private async testS2Connection(): Promise<void> {
        try {
            this.s2 = new S2({
                accessToken: this.token,
            });

            let tail = await this.s2.records.checkTail({
                s2Basin: this.basin,
                stream: this.keystrokes_stream,
            });

            let seqNum = tail.tail.seqNum;
            let timestamp = tail.tail.timestamp;

            await this.writelnAsync(`\x1b[32mConnection successful!\x1b[0m`);
            await this.writelnAsync("");
            await this.writelnAsync(`Connected to \x1b[32ms2://${this.basin}/${this.keystrokes_stream}\x1b[0m`);
            await this.writelnAsync(`Current tail seqNum: ${seqNum}, timestamp: ${timestamp}`);
            await this.writelnAsync("");

            this.setupState = SetupState.STREAMING;

            // Send initial window size
            const {cols, rows} = this.terminal;
            await this.sendWindowResize(cols, rows);

            await this.startS2Streaming();
        } catch (error) {
            await this.writelnAsync(`\x1b[31mConnection failed: ${error}\x1b[0m`);
            await this.writelnAsync("");

            this.setupState = SetupState.COLLECTING_TOKEN;
            await this.writelnAsync("Please enter S2 token: ");
            await this.writeAsync("> ");
        }
    }

    private async sendKeystroke(data: string): Promise<void> {
        try {
            await this.s2.records.append({
                stream: this.keystrokes_stream,
                s2Basin: this.basin,
                appendInput: {
                    records: [
                        {
                            body: data,
                            headers: [["type", "keystroke"]],
                            timestamp: Date.now(),
                        },
                    ],
                },
            });
        } catch (error) {
            console.error("Failed to send keystroke to S2:", error);
        }
    }

    private async sendWindowResize(cols: number, rows: number): Promise<void> {
        try {
            await this.s2.records.append({
                stream: this.keystrokes_stream,
                s2Basin: this.basin,
                appendInput: {
                    records: [
                        {
                            body: "",
                            headers: [
                                ["type", "window"],
                                ["rows", rows.toString()],
                                ["cols", cols.toString()]
                            ],
                            timestamp: Date.now()
                        },
                    ],
                },
            });
            console.log(`Sent window resize: ${cols}x${rows}`);
        } catch (error) {
            console.error("Failed to send window resize to S2:", error);
        }
    }

    private async startS2Streaming(): Promise<void> {
        try {
            console.log("Starting S2 stream reading...");

            let readParams: any = {
                stream: this.pty_stream,
                s2Basin: this.basin,
            };

            if (this.since) {
                // Replay mode: start from specific timestamp
                readParams.timestamp = this.since;
                console.log(`Using timestamp: ${this.since} (${new Date(this.since).toISOString()})`);
            } else {
                // Live mode: start from current tail
                readParams.tailOffset = 0;
                console.log("Starting from live tail");
                this.isLiveMode = true;
            }

            const stream = await this.s2.records.read(
                readParams,
                {
                    acceptHeaderOverride: ReadAcceptEnum.textEventStream,
                },
            );

            await this.writelnAsync(
                `Now reading from \x1b[32ms2://${this.basin}/${this.pty_stream}\x1b[0m`,
            );
            await this.writelnAsync("Terminal ready - start typing!");
            await this.writelnAsync("");

            // TODO: this is streaming via SSE, so there is no mechanism for backpressure...
            // Would be much preferable to fetch in small blocks, using a start seqNum and
            // a bytes-based limit. Can be a follow up...
            if (Symbol.asyncIterator in stream) {
                for await (const event of stream) {
                    await this.applyS2Record(event);
                }
            }
        } catch (error) {
            console.error("S2 streaming error:", error);
            await this.writelnAsync(`\x1b[31mStreaming error: ${error}\x1b[0m`);
        }
    }

    private async applyS2Record(event: ReadEvent): Promise<void> {
        if (event.event == "batch") {
            let batch: Batch = event;
            for (const record of batch.data.records) {
                await this.processRecord(record);
            }
        } else {
            console.log(`Received non-batch from S2 read: ${event.event}`);
        }
    }

    private async processRecord(record: SequencedRecord): Promise<void> {
        // Check if we've caught up to live mode
        if (record.timestamp) {
            const now = Date.now();
            const timeDiffFromNow = now - record.timestamp;

            // Within 5 seconds of current time or in the future
            if (timeDiffFromNow <= 5000) {
                if (!this.isLiveMode && this.since) {
                    console.log("Caught up to live time - entering live mode");
                    await this.writelnAsync("\x1b[32m[Live mode activated]\x1b[0m");
                    this.isLiveMode = true;
                }
            }
        }

        // Handle timing for replay mode (only if not in live mode)
        if (this.since && !this.isLiveMode && record.timestamp && this.lastRecordTimestamp) {
            const timeDiff = record.timestamp - this.lastRecordTimestamp;
            const adjustedDelay = timeDiff / this.speedup;

            if (adjustedDelay > 0) {
                await this.sleep(adjustedDelay);
            }
        }

        this.lastRecordTimestamp = record.timestamp;

        let body = record.body || "";

        // TODO: Don't await, to help with the record delay math.
        // Ideally we would incorporate the actual write duration into our delay math, but
        // this is a reasonable workaround for now.
        this.writeAsync(body);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private writeAsync(data: string): Promise<void> {
        return new Promise<void>((resolve) => {
            this.terminal.write(data, resolve);
        });
    }

    private writelnAsync(data: string): Promise<void> {
        return new Promise<void>((resolve) => {
            this.terminal.writeln(data, resolve);
        });
    }

}

// Initialize the terminal when the page loads
document.addEventListener("DOMContentLoaded", async () => {
    const streamingTerminal = new StreamingTerminal();
    await streamingTerminal.initialize();

    // Make it globally available for debugging
    (window as any).terminal = streamingTerminal;
});
