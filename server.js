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
app.use(cors()); // Allow your React app to make requests
app.use(express.json()); // Allow the server to read JSON

// ---===================================---
// --- V1 ENDPOINT: POLISH SCRIPT (Our only endpoint)
// ---===================================---
app.post('/polish', async (req, res) => {
  try {
    const { rawScript, styleExamples } = req.body;

    if (!rawScript) {
      return res.status(400).json({ error: 'No script provided' });
    }

    // This dynamically builds the "lessons" for the AI
    const stylePrompt = styleExamples
      ? `
        ## 1. Target Style Examples
        First, carefully study these examples of the creator's final, polished, HUMAN-WRITTEN scripts. Your goal is to match this style perfectly.
        **Examples:**
        ---
        ${styleExamples}
        ---
      `
      : `
        ## 1. Target Style
        No specific style examples were provided. Use a standard, engaging, and clear YouTube video script style.
      `;

    // --- The "Polishing" Prompt ---
    const prompt = `
      You are a highly-skilled script editor, "ScriptPolish AI". Your task is to rewrite a "Raw Script" to match a specific style, following strict rules.

      ${stylePrompt}

      ## 2. Your Task & Rules
      Now, take the following "Raw Script" and completely rewrite it.

      **CRITICAL RULE 1 (MANDATORY): PRESERVE ALL FACTS & STRUCTURE.**
      Do NOT add any new information, stories, product names, or examples that are not in the raw script. You must keep the original script's entire framework. Your job is to polish, *not* to add new content.

      **RULE 2: MATCH THE VOICE.**
      - Fix all grammar and spelling.
      - Make it highly engaging for a video.
      - If style examples were provided, infuse the script with the same **tone, pacing, and personality** you just learned.
      - Ruthlessly remove all generic AI phrases ("In conclusion," "Moreover," "Delve into").

      **RULE 3: PRODUCE OUTPUT.**
      - Return ONLY the final, polished script.
      - Do NOT add any extra conversation, preamble, or introduction.
    `;
    
    // --- Groq API Call ---
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: rawScript }
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
  console.log(`ScriptPolish AI server (V2.1 - Pure Learning) listening on http://localhost:${port}`);
});