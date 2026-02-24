import { CopilotClient } from "@github/copilot-sdk";
import { calculate } from "./tools/calculate.js";
import { queryArchive } from "./tools/queryArchive.js";
import { getArchiveWord } from "./tools/getArchiveWord.js";
import { validateSpeakText } from "./tools/validateSpeakText.js";
import { appendFile, readFile } from "node:fs/promises";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { initialPrompt } from "./files/initialPrompt.js";

type CopilotEvents = {
  "ws:open": () => void;
  "ws:message": (message: string) => void;
  "ws:error": (error: Error) => void;
  "copilot:response": (response: unknown) => void;
};


type Fragment = { word: string; timestamp: number };

type ChallengeEvent = {
  type: "challenge";
    message: Fragment[] | { fragments: Fragment[] };
};

type ErrorEvent = {
    type: "error";
    message: string;
};

type NeonPayload =
    | { type: "enter_digits"; digits: string }
    | { type: "speak_text"; text: string };


interface Copilot {
    client: CopilotClient;
    session: any;
    websocket: WebSocket | null;
    calculate: (operationOrExpression: string, num1?: number, num2?: number) => number;
    queryArchive: (page: string) => Promise<any>;
    getArchiveWord: (page: string, position: number) => Promise<string>;
    running: boolean;
    promiseHandler: PromiseProcessor<any>;
    pendingPrompts: string[];
    lastChallengeSentence: string;
    resumeContextCache: Map<string, string>;
}

interface PromiseHandler<T> {
    promise: Promise<T>;
    resolveProcessor: ((value: T) => void) | null;
    rejectProcessor: ((reason?: unknown) => void) | null;
}

class PromiseProcessor<T> implements PromiseHandler<T> {
    promise: Promise<T>;
    resolveProcessor: ((value: T) => void) | null;
    rejectProcessor: ((reason?: unknown) => void) | null;

    constructor() {
        this.resolveProcessor = null;
        this.rejectProcessor = null;
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolveProcessor = resolve;
            this.rejectProcessor = reject;
        });
    }
}

function isChallengeEvent(value: unknown): value is ChallengeEvent {
  if (!value || typeof value !== "object") return false;

  const obj = value as Record<string, unknown>;
  if (obj.type !== "challenge") return false;

  const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return false;

    const fragments = Array.isArray(message)
        ? message
        : Array.isArray((message as Record<string, unknown>).fragments)
            ? (message as Record<string, unknown>).fragments as unknown[]
            : null;

    if (!fragments) return false;

    return fragments.every((f) => {
    const frag = f as Record<string, unknown>;
    return typeof frag.word === "string" && typeof frag.timestamp === "number";
  });
}

function isErrorEvent(value: unknown): value is ErrorEvent {
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    return obj.type === "error" && typeof obj.message === "string";
}


class Copilot extends EventEmitter {
    neonCode: string;
    neonUrl: string;

    constructor(copilotClient: CopilotClient, neonCode: string, neonUrl: string) {
        super();
        console.log("[Copilot] constructor called");
        this.client = copilotClient;
        this.session = null;
        this.calculate = calculate;
        this.queryArchive = queryArchive;
        this.getArchiveWord = getArchiveWord;
        this.websocket = null;
        this.neonCode = neonCode;
        this.neonUrl = neonUrl;
        this.running = true;
        this.promiseHandler = new PromiseProcessor<any>();
        this.pendingPrompts = [];
        this.lastChallengeSentence = "";
        this.resumeContextCache = new Map<string, string>();
    }

    private initializeWebSocket() {
        console.log("[Copilot] initializeWebSocket called");
        if (this.websocket) {
            console.log("[Copilot] WebSocket already initialized");
            return;
        }
        this.websocket = new WebSocket(this.neonUrl);
        this.websocket.on("open", () => this.emit("ws:open"));
        this.websocket.on("message", (data) => this.getMessage(data));
        this.websocket.on("error", (err) => this.emit("ws:error", err as Error));
    }

    private getCodebaseAttachments() {
        return [
            { type: "directory" as const, path: "./copilot", displayName: "copilot" },
            { type: "file" as const, path: "./index.ts", displayName: "index.ts" },
            { type: "file" as const, path: "./package.json", displayName: "package.json" },
        ];
    }

    private async flushPendingPrompts() {
        if (!this.session || this.pendingPrompts.length === 0) {
            return;
        }

        const prompts = [...this.pendingPrompts];
        this.pendingPrompts = [];
        for (const prompt of prompts) {
            await this.sendResults(prompt);
        }
    }


    private registerSessionListeners() {
        console.log("[Copilot] registerSessionListeners called");
        this.session.on((event: any) => {
            if (event?.type === "assistant.usage") {
                return;
            }

            const sanitizeForLog = (value: any): any => {
                if (Array.isArray(value)) {
                    return value.map(sanitizeForLog);
                }

                if (!value || typeof value !== "object") {
                    return value;
                }

                const output: Record<string, unknown> = {};
                for (const [key, child] of Object.entries(value)) {
                    if (key === "reasoningOpaque") {
                        continue;
                    }
                    output[key] = sanitizeForLog(child);
                }
                return output;
            };

            const sanitizedData = sanitizeForLog(event?.data ?? event);
            console.log("[LLM event]", event?.type ?? "unknown", sanitizedData);
        });

        this.session.on("assistant.message_delta", (event: any) => {
            const delta = event?.data?.deltaContent ?? "";
            if (delta) {
                console.log("[LLM delta]", delta);
            }
        });

        this.session.on("assistant.message", async (event: any) => {
            const content = event?.data?.content ?? "";
            console.log("[LLM message]", content);
            this.emit("copilot:response", content);
            await this.handleAssistantResponse(content);
        });

        this.session.on("assistant.reasoning", (event: any) => {
            const content = event?.data?.content ?? "";
            if (content) {
                console.log("[LLM reasoning]", content);
            }
        });

        this.session.on("session.error", (event: any) => {
            const message = event?.data?.message ?? "Unknown session error";
            console.error("[LLM session.error]", message);
            this.emit("ws:error", new Error(message));
        });
    }

    private async handleAssistantResponse(content: string) {
        console.log("[Copilot] handleAssistantResponse called");
        const result = await this.interpreter(content);
        if (!result) {
            return;
        }

        if (typeof result === "object" && result.type && (result.type === "enter_digits" || result.type === "speak_text")) {
            await this.sendNeonPayload(result as NeonPayload);
            return;
        }

        await this.session.send({
            prompt: `Tool result: ${typeof result === "string" ? result : JSON.stringify(result)}\nUse this result and continue. Return only the final NEON protocol JSON object.`,
            mode: "immediate",
            attachments: this.getCodebaseAttachments(),
        });
    }

    private async logPayload(payload: unknown) {
        console.log("[Copilot] logPayload called");
        const historyLine = `${new Date().toISOString()} ${JSON.stringify(payload)}\n`;
        await appendFile("./copilot/files/history.txt", historyLine, "utf8");
    }

    private async sendNeonPayload(payload: NeonPayload): Promise<boolean> {
        if (payload.type === "speak_text") {
            const validation = validateSpeakText(payload.text, this.lastChallengeSentence);
            if (!validation.valid) {
                console.warn("[Copilot] speak_text rejected by validator:", validation.reason);
                if (this.session) {
                    await this.session.send({
                        prompt: `Your previous speak_text payload is invalid. ${validation.reason} Return ONLY valid NEON JSON for type \"speak_text\" that satisfies the character constraint from the latest challenge.`,
                        mode: "immediate",
                    });
                }
                return false;
            }
        }

        if (!this.websocket) {
            if (this.session) {
                await this.session.send({
                    prompt: "WebSocket is not initialized. Call the initiate tool before transmitting NEON payloads.",
                });
            }
            return false;
        }

        await this.logPayload(payload);
        this.websocket.send(JSON.stringify(payload));
        return true;
    }

    private buildTransmitPayload(args: any[]) {
        console.log("[Copilot] buildTransmitPayload called");
        if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
            const payload = args[0] as Record<string, unknown>;
            if (payload.type === "enter_digits" && typeof payload.digits === "string") {
                return { type: "enter_digits", digits: payload.digits };
            }
            if (payload.type === "speak_text" && typeof payload.text === "string") {
                return { type: "speak_text", text: payload.text };
            }
            return null;
        }

        if (args.length >= 2 && args[0] === "enter_digits" && typeof args[1] === "string") {
            return { type: "enter_digits", digits: args[1] };
        }

        if (args.length >= 2 && args[0] === "speak_text" && typeof args[1] === "string") {
            return { type: "speak_text", text: args[1] };
        }

        return null;
    }

    private buildImmediateResponse(sentence: string): NeonPayload | null {
        const directFrequency = sentence.match(/(?:respond|enter|press)\s+on\s+frequency\s+(\d+)/i);
        if (directFrequency) {
            return { type: "enter_digits", digits: directFrequency[1] };
        }

        const conditionedFrequency = sentence.match(/if\s+your\s+pilot[\s\S]*?respond\s+on\s+frequency\s+(\d+)/i);
        if (conditionedFrequency) {
            return { type: "enter_digits", digits: conditionedFrequency[1] };
        }

        const asksForVesselCode = /vessel\s+authorization\s+code/i.test(sentence);
        if (asksForVesselCode) {
            const requiresPound = /pound\s+key|followed\s+by\s+the\s+pound\s+key|#/.test(sentence.toLowerCase());
            return {
                type: "enter_digits",
                digits: requiresPound ? `${this.neonCode}#` : this.neonCode,
            };
        }

        return null;
    }

    private shouldAutoTransmitCalculatedResult(sentence: string): { usePound: boolean } | null {
        const asksToCompute = /(compute|calculate)/i.test(sentence);
        const asksToTransmit = /(transmit|enter|respond)/i.test(sentence);
        if (!asksToCompute || !asksToTransmit) {
            return null;
        }

        const usePound = /pound\s+key|followed\s+by\s+the\s+pound\s+key|#/.test(sentence.toLowerCase());
        return { usePound };
    }

    private buildImmediateMathResponse(sentence: string): NeonPayload | null {
        const shouldCompute = this.shouldAutoTransmitCalculatedResult(sentence);
        if (!shouldCompute) {
            return null;
        }

        const expressionMatch = sentence.match(/:\s*(Math\.floor\([\s\S]*\)|[0-9\s+\-*/%().]+)$/i);
        if (!expressionMatch) {
            return null;
        }

        const expression = expressionMatch[1].trim();
        try {
            // Parse the expression to extract operation and operands
            const opMatch = expression.match(/(\d+)\s*([+\-*/%])\s*(\d+)/);
            if (!opMatch) {
                return null;
            }
            const num1 = parseInt(opMatch[1], 10);
            const operation = opMatch[2];
            const num2 = parseInt(opMatch[3], 10);
            
            const result = this.calculate(operation, num1, num2);
            return {
                type: "enter_digits",
                digits: shouldCompute.usePound ? `${result}#` : `${result}`,
            };
        } catch {
            return null;
        }
    }

    private buildImmediateCrewManifestResponse(sentence: string): NeonPayload | null {
        const lower = sentence.toLowerCase();
        if (/transmission\s+verification|earlier\s+you\s+transmitted|word\s+of\s+that\s+transmission/.test(lower)) {
            return null;
        }
        const asksCrewManifest = /crew\s+manifest|crew\s+member/.test(lower);
        const asksSpeak = /\b(speak|transmit)\b/.test(lower);
        if (!asksCrewManifest || !asksSpeak) {
            return null;
        }

        let text: string | null = null;

        if (/best\s+project|project\s*\(work\s+or\s+personal\)|notable\s+project/.test(lower)) {
            text = "Brandon's best project was automating repetitive TVA asset workflows using Python, JavaScript, and Power Automate, streamlining processing speed and consistency across asset management tasks.";
        } else if (/\bskills\b|technical\s+skills|core\s+strengths/.test(lower)) {
            text = "Brandon is skilled in JavaScript, Python, React, Node.js, Express, MongoDB, AWS microservices, RESTful API development, and CRM workflow automation, with strong practical delivery across client systems.";
        } else if (/education|degree|university|school|certification|certifications/.test(lower)) {
            text = "Brandon holds a B.S. in Business Administration from Southern Adventist University and is certified in Excel, JavaScript algorithms, front-end libraries, and React/Node.js development workflows.";
        } else if (/work\s+experience|employment|recent\s+deployment|recent\s+role|roles?/.test(lower)) {
            text = "Brandon works as a freelance full stack developer and web developer, after experience in accounts payable and TVA asset management, combining software delivery, process automation, and operational discipline.";
        } else if (/granted\s+access|good\s+fit|convince\s+us|fit\s+for\s+the\s+mission/.test(lower)) {
            text = "Brandon combines AWS microservices, API engineering, and automation expertise with proven execution at TVA and client teams, making him a reliable, mission-ready operator who can integrate quickly and solve complex NEON workflows.";
        }

        if (!text) {
            return null;
        }

        const validation = validateSpeakText(text, sentence);
        if (!validation.valid) {
            return null;
        }

        return { type: "speak_text", text };
    }

    private extractWords(value: string): string[] {
        return String(value ?? "").match(/[A-Za-z0-9'-]+/g) ?? [];
    }

    private findRelevantPriorTransmission(topic: string, lines: string[]): string | null {
        const topicLower = topic.toLowerCase();
        const topicKeywords = this.extractWords(topicLower).filter((word) => word.length > 2);

        const candidateTexts: string[] = [];
        for (const line of lines) {
            const jsonStart = line.indexOf("{");
            if (jsonStart < 0) {
                continue;
            }

            try {
                const payload = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
                if (payload.type === "speak_text" && typeof payload.text === "string") {
                    candidateTexts.push(payload.text);
                }
            } catch {
                continue;
            }
        }

        if (candidateTexts.length === 0) {
            return null;
        }

        let bestText: string | null = null;
        let bestScore = -1;

        for (const text of candidateTexts) {
            const lowerText = text.toLowerCase();
            const score = topicKeywords.reduce((sum, keyword) => sum + (lowerText.includes(keyword) ? 1 : 0), 0);
            if (score > bestScore) {
                bestScore = score;
                bestText = text;
            }
        }

        if (bestScore <= 0) {
            return candidateTexts[candidateTexts.length - 1] ?? null;
        }

        return bestText;
    }

    private async buildImmediateTransmissionVerificationResponse(sentence: string): Promise<NeonPayload | null> {
        const lower = sentence.toLowerCase();
        if (!/transmission\s+verification|earlier\s+you\s+transmitted/.test(lower)) {
            return null;
        }

        const nthWordMatch = sentence.match(/speak\s+the\s+(\d+)(?:st|nd|rd|th)?\s+word\s+of\s+that\s+transmission/i);
        if (!nthWordMatch) {
            return null;
        }

        const wordPosition = Number.parseInt(nthWordMatch[1], 10);
        if (!Number.isInteger(wordPosition) || wordPosition < 1) {
            return null;
        }

        const topicMatch = sentence.match(/earlier\s+you\s+transmitted\s+your\s+crew\s+member'?s\s+(.+?)\.\s+speak\s+the/i);
        const topic = topicMatch?.[1] ?? "";

        let historyContent = "";
        try {
            historyContent = await readFile("./copilot/files/history.txt", "utf8");
        } catch {
            return null;
        }

        const historyLines = historyContent.split(/\r?\n/).filter(Boolean);
        const sourceText = this.findRelevantPriorTransmission(topic, historyLines);
        if (!sourceText) {
            return null;
        }

        const words = this.extractWords(sourceText);
        const selectedWord = words[wordPosition - 1] ?? "";
        if (!selectedWord) {
            return null;
        }

        return { type: "speak_text", text: selectedWord };
    }

    async getMessage(data: WebSocket.RawData) {
        console.log("[Copilot] getMessage called");
        console.log("[Copilot] Raw message data:", data.toString());
        try {
            console.log("[Copilot] Attempting to parse message as JSON...");
           
            const parsed: unknown = JSON.parse(data.toString());

            if (isErrorEvent(parsed)) {
                console.error("[Copilot] NEON error:", parsed.message);
                return;
            }

            if (!isChallengeEvent(parsed)) {
                console.log("[Copilot] Parsed JSON is not a ChallengeEvent.");
                return;
            }

            const fragments = Array.isArray(parsed.message)
                ? parsed.message
                : parsed.message.fragments;
            const sorted = [...fragments].sort((a, b) => a.timestamp - b.timestamp);
            const sentence = sorted.map((f) => f.word).join(" ");
            console.log("[Copilot] Parsed sentence:", sentence);
            this.lastChallengeSentence = sentence;

            const immediatePayload = this.buildImmediateResponse(sentence);
            if (immediatePayload) {
                console.log("[Copilot] Sending immediate frequency response.");
                await this.logPayload(immediatePayload);
                if (!this.websocket) {
                    throw new Error("WebSocket is not initialized");
                }
                this.websocket.send(JSON.stringify(immediatePayload));
                return;
            }

            const immediateMathPayload = this.buildImmediateMathResponse(sentence);
            if (immediateMathPayload) {
                console.log("[Copilot] Sending immediate math response.");
                await this.logPayload(immediateMathPayload);
                if (!this.websocket) {
                    throw new Error("WebSocket is not initialized");
                }
                this.websocket.send(JSON.stringify(immediateMathPayload));
                return;
            }

            const immediateVerificationPayload = await this.buildImmediateTransmissionVerificationResponse(sentence);
            if (immediateVerificationPayload) {
                console.log("[Copilot] Sending immediate verification response.");
                await this.logPayload(immediateVerificationPayload);
                if (!this.websocket) {
                    throw new Error("WebSocket is not initialized");
                }
                this.websocket.send(JSON.stringify(immediateVerificationPayload));
                return;
            }

            const immediateCrewManifestPayload = this.buildImmediateCrewManifestResponse(sentence);
            if (immediateCrewManifestPayload) {
                console.log("[Copilot] Sending immediate crew-manifest response.");
                await this.logPayload(immediateCrewManifestPayload);
                if (!this.websocket) {
                    throw new Error("WebSocket is not initialized");
                }
                this.websocket.send(JSON.stringify(immediateCrewManifestPayload));
                return;
            }

            if (!this.session) {
                console.log("[Copilot] Session not ready; queueing prompt.");
                this.pendingPrompts.push(sentence);
                return;
            }

            await this.sendResults(sentence);
        } catch (error) {
        console.error("Invalid websocket JSON:", error);
        }
    }

    async start(){
        console.log("[Copilot] start called");
        console.log("[Copilot] Creating session...");
        this.session = await this.client.createSession({
            model: "gpt-5",
            availableTools: [],
            systemMessage: {
                mode: "replace",
                content: `You are a protocol assistant for the NEON challenge.
Never call built-in tools.
Do not request file reads, shell commands, or external tools.
Respond only with either:
1) a tool invocation JSON object: {"tool":"name","args":[...]}
2) a final NEON payload JSON object: {"type":"enter_digits","digits":"..."} or {"type":"speak_text","text":"..."}
No additional text.`,
            },
        });
        if (!this.session || !this.session.sessionId) {
            throw new Error("[Copilot] Session verification failed: createSession returned invalid session");
        }
        console.log("[Copilot] Session ready.");
        console.log("[Copilot] Session verified. sessionId:", this.session.sessionId);

        try {
            const sdkStatus = await this.client.getStatus();
            const authStatus = await this.client.getAuthStatus();
            console.log("[Copilot] SDK status:", sdkStatus);
            console.log("[Copilot] Auth status:", authStatus);

            if (!authStatus?.isAuthenticated) {
                console.error("[Copilot] Not authenticated. Run `copilot auth login` (or authenticate via GitHub CLI) and retry.");
            }
        } catch (error) {
            console.error("[Copilot] Failed to get SDK/auth status:", error);
        }

        this.registerSessionListeners();
        await this.flushPendingPrompts();
        try {
            const initialResponse = await this.session.sendAndWait(
                {
                    prompt: `${initialPrompt}\n\nVessel Authorization Code (NEON Code): ${this.neonCode}`,
                    mode: "immediate",
                    attachments: this.getCodebaseAttachments(),
                },
                120000,
            );
            console.log("[Copilot] Initial prompt response:", initialResponse?.data?.content ?? initialResponse);
        } catch (error) {
            console.error("[Copilot] Initial prompt sendAndWait failed:", error);
        }
        console.log("[Copilot] Initial prompt sent.");
    }


    async promptWithFs(filePath: string) {
        console.log("[Copilot] promptWithFs called");
        let fileContent = this.resumeContextCache.get(filePath);
        if (!fileContent) {
            fileContent = await readFile(filePath, "utf8");
            this.resumeContextCache.set(filePath, fileContent);
        }

        await this.session.send({
            prompt: `Crew manifest context for current challenge. Use this immediately.\n\nFile: ${filePath}\n---\n${fileContent}\n---`,
            mode: "immediate",
        });
    }

    private getResumeFileForChallenge(): string {
        const sentence = this.lastChallengeSentence.toLowerCase();

        if (/project|best\s+project|notable\s+project|work\s+or\s+personal/.test(sentence)) {
            return "./copilot/files/resume.projects.txt";
        }

        if (/education|degree|university|school|certification|certifications|skills|skill/.test(sentence)) {
            return "./copilot/files/resume.education_skills.txt";
        }

        if (/work|experience|employment|job|role|recent\s+deployment|recent\s+role/.test(sentence)) {
            return "./copilot/files/resume.experience.txt";
        }

        return "./copilot/files/resume.summary.txt";
    }

    async sendResults(results: any, includeAttachments = false){
        console.log("[Copilot] sendResults called");
        const promptContent = typeof results === "string" ? results : JSON.stringify(results);
        await this.session.send({
            prompt: promptContent,
            mode: "immediate",
            attachments: includeAttachments ? this.getCodebaseAttachments() : undefined,
        });
    }

    async interpreter(response: string){
        console.log("[Copilot] interpreter called");
        //allow the llm to execute functions in response and get the results 
        //example response: {"tool":"calculate","args":["add",5,3]}
        let parsedResponse: any;
        try {
            parsedResponse = JSON.parse(response);
        } catch {
            return null;
        }

        if (parsedResponse.type === "enter_digits" || parsedResponse.type === "speak_text") {
            return parsedResponse;
        }

        switch(parsedResponse.tool){
            case 'calculate':
                const result = this.calculate(parsedResponse.args[0], parsedResponse.args[1], parsedResponse.args[2]);
                console.log("Function result:", result);

                const appendPoundArg = parsedResponse.args[1];
                const appendPound = typeof appendPoundArg === "boolean"
                    ? appendPoundArg
                    : this.shouldAutoTransmitCalculatedResult(this.lastChallengeSentence)?.usePound ?? false;

                const calculatePayload: NeonPayload = {
                    type: "enter_digits",
                    digits: appendPound ? `${result}#` : `${result}`,
                };
                await this.sendNeonPayload(calculatePayload);
                break;

            case 'floor':
                const floorResult = Math.floor(parsedResponse.args[0]);
                await this.sendResults(floorResult);
                break;

            case 'queryArchive':
                const archiveResult = await this.queryArchive(parsedResponse.args[0]);
                console.log("Archive result:", archiveResult);
                await this.sendResults(archiveResult?.extract ?? archiveResult);
                break;

            case 'getArchiveWord':
                const archiveWord = await this.getArchiveWord(parsedResponse.args[0], Number(parsedResponse.args[1]));
                if (/\b(speak|transmit)\b/i.test(this.lastChallengeSentence) && this.websocket) {
                    const archivePayload: NeonPayload = { type: "speak_text", text: archiveWord };
                    await this.sendNeonPayload(archivePayload);
                    break;
                }
                await this.sendResults(archiveWord);
                break;

            case 'validateSpeakText':
                const text = String(parsedResponse.args?.[0] ?? "");
                const challengeSentence = String(parsedResponse.args?.[1] ?? this.lastChallengeSentence);
                const validationResult = validateSpeakText(text, challengeSentence);
                await this.sendResults(validationResult);
                break;

            case "transmit":
                //transmit data to websocket and do not send this result back to the llm
                const transmitPayload = this.buildTransmitPayload(parsedResponse.args ?? []);
                if (transmitPayload) {
                    await this.sendNeonPayload(transmitPayload as NeonPayload);
                }
                return null;

            case 'initiate':
                this.initializeWebSocket();
                return null;
            
            case 'getIndexOf': 
                const sourceText = String(parsedResponse.args[0] ?? "");
                const positionOrNeedle = parsedResponse.args[1];
                const numericPosition = Number(positionOrNeedle);

                if (Number.isInteger(numericPosition) && numericPosition > 0) {
                    const words = sourceText.match(/[A-Za-z0-9'-]+/g) ?? [];
                    const wordAtPosition = words[numericPosition - 1] ?? "";
                    await this.sendResults(wordAtPosition);
                } else {
                    await this.sendResults(sourceText.indexOf(String(positionOrNeedle ?? "")));
                }
                break;
            case 'getResume':
                await this.promptWithFs(this.getResumeFileForChallenge());
                break;
            case 'getHistory':
                if (!/\b(recall|earlier|previous|history|word\s+from\s+one\s+of\s+its\s+earlier)\b/i.test(this.lastChallengeSentence)) {
                    return "getHistory is only needed for transmission verification prompts that ask you to recall earlier responses. Continue with the current challenge directly.";
                }
                await this.promptWithFs("./copilot/files/history.txt");
                break;

            default:
                return "Invalid function";
        }
    }


    async shutdown(){
        console.log("[Copilot] shutdown called");
        this.running = false;
        process.exit(0)
    }
}

export { Copilot };

