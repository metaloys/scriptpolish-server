import express from 'express';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import cors from 'cors';

// Load environment variables
dotenv.config();

const app = express();
const port = 3001;

// --- Groq Setup ---
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// --- Middleware ---
app.use(cors());
app.use(express.json());

// ---===================================---
// --- V1 ENDPOINT: POLISH SCRIPT
// ---===================================---
app.post('/polish', async (req, res) => {
  try {
    const { rawScript, styleExamples } = req.body;

    if (!rawScript) {
      return res.status(400).json({ error: 'No script provided' });
    }

    const stylePrompt = styleExamples
      ? `
        ## 1. The Creator's Voice Profile (THE AUTHORITY)
        First, study these examples of the creator's final, polished, HUMAN-WRITTEN scripts. This is the **only** voice, tone, and pacing you are allowed to use.
        **Examples:**
        ---
        ${styleExamples}
        ---
      `
      : `
        ## 1. The Creator's Voice Profile
        No specific style examples were provided. Use a standard, engaging, and clear YouTube video script style.
      `;

    // --- The "Polishing" Prompt (UPDATED) ---
    const prompt = `
      You are a master script editor. Your one and only job is to **re-write** a "Raw Script" so it sounds exactly like the "Creator's Voice Profile."

      ${stylePrompt}

      ## 2. The Raw Script (FACTS ONLY)
      The "Raw Script" you will be given is a **boring, robotic list of facts**. It is provided **only** for its information, structure, and key data points.

      ## 3. Your Task & Rules (MANDATORY)
      You must **re-write the "Raw Script" from scratch**.

      **CRITICAL RULE 1: DISCARD THE RAW VOICE.**
      - You are **FORBIDDEN** from using the "Raw Script's" original intro, outro, transitions, or any of its "friendly" or "generic" phrasing.
      - Your output must sound like it was written *by the creator* in the "Voice Profile," using *only* the *facts* from the "Raw Script."
      
      **CRITICAL RULE 2: PRESERVE ALL FACTS.**
      - You **MUST** keep all facts, names, statistics, and the core structural points (e.g., "Reason 1," "Reason 2") from the "Raw Script."
      - Do **NOT** add any new information, stories, or facts that are not in the "Raw Script."

      **CRITICAL RULE 3: PRODUCE OUTPUT.**
      - Return ONLY the final, polished script.
      - Do NOT add any preamble like "Here is the polished script:".
    `;
    
    // --- Groq API Call ---
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: rawScript } // This is the "Raw Script (FACTS ONLY)"
      ],
      model: 'llama-3.3-70b-versatile',
    });

    const polishedText = chatCompletion.choices[0]?.message?.content;
    if (!polishedText) throw new Error("No response from AI");
    res.json({ polishedScript: polishedText.trim() });

  } catch (error) {
    console.error('Error from Groq (/polish):', error);
    res.status(500).json({ error: 'Failed to polish script' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`ScriptPolish AI server (V2.3 - Strict FactsOnly) listening on http://localhost:${port}`);
});