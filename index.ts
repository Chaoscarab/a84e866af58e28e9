// Import the express in typescript file
import express from 'express';
import { CopilotClient } from "@github/copilot-sdk";
import { Copilot } from "./copilot/copilot.js";
import dotenv from 'dotenv'

dotenv.config();

const app: express.Application = express();

const port: number = 3000;
const NEON: string = process.env.NEON_URL ?? "wss://neonhealth.software/agent-puzzle/challenge";
const NEON_CODE = process.env.NEON_CODE 

app.get('/', (_req, _res) => {
    _res.send("beginning challenge...");
    console.log("[HTTP] / hit - starting copilot chain...");
    let copilotClient = new CopilotClient();
    let copilot = new Copilot(copilotClient, NEON_CODE ?? "", NEON);
    copilot.start().catch((error) => {
        console.error("[Copilot] start failed:", error);
    });
    
});


app.listen(port, () => {
    console.log(`TypeScript with Express 
         http://localhost:${port}/`);
});