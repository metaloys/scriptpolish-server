import express from 'express';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import cors from 'cors';
import { supabase } from './supabaseClient.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const levenshtein = require('levenshtein-edit-distance');

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
app.use(express.json({ limit: '10mb' })); 

// ---================================---
// --- V3 HELPER FUNCTIONS
// ---================================---

// Helper 1: Analyze the script's topic
async function analyzeTopicCategory(scriptText) {
  try {
    const predefinedCategories = [
      "Productivity", "Tech", "Finance", "Student Advice", 
      "Health", "Relationships", "Creator Economy", "Philosophy", "Other"
    ];

    const prompt = `
      You are a fast and accurate text classifier. Your only job is to assign one category to the following script.
      Choose ONLY from this list: ${predefinedCategories.join(", ")}.
      Return only the single category name, and nothing else.

      SCRIPT:
      ---
      ${scriptText.substring(0, 2000)}
      ---
    `;

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'system', content: prompt }],
      model: 'llama-3.1-8b-instant',
    });

    const category = chatCompletion.choices[0]?.message?.content.trim() || "Other";
    
    if (predefinedCategories.includes(category)) {
      return category;
    }
    return "Other";
  } catch (error) {
    console.error("Error analyzing topic:", error);
    return "Other";
  }
}

// Helper 2: Select the 5 most relevant examples
async function selectBestExamples(userId, topic) {
  const { data, error } = await supabase
    .from('voice_examples')
    .select('script_text')
    .eq('user_id', userId)
    .order('topic_category', { ascending: topic !== 'Other' })
    .order('quality_score', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error("Error selecting best examples:", error);
    return [];
  }
  
  return data.map(row => row.script_text);
}

// ---================================---
// --- V3 POLISH ENDPOINT (V4 PROMPT)
// ---================================---
app.post('/polish', async (req, res) => {
  try {
    const { rawScript, userId } = req.body;
    if (!rawScript || !userId) {
      return res.status(400).json({ error: 'Missing script or user ID' });
    }

    const scriptTopic = await analyzeTopicCategory(rawScript);
    const relevantExamples = await selectBestExamples(userId, scriptTopic);

    const stylePrompt = relevantExamples.length > 0
      ? `
        ## 1. The Creator's Voice Profile (THE ONLY AUTHORITY)
        You MUST study these ${relevantExamples.length} "gold-standard" scripts. This is the **only** voice, tone, and pacing you are allowed to use.
        **Examples:**
        ---
        ${relevantExamples.join('\n\n---\n\n')}
        ---
      `
      : `
        ## 1. The Creator's Voice Profile
        No style examples found. Polish using a standard, engaging, and clear YouTube video script style.
      `;

    // --- V4 "Mark" Prompt ---
    const prompt = `
      You are a "Voice Mimic" AI. Your job is to re-write a "Fact Sheet" in the *exact* style of the "Creator's Voice Profile."

      ${stylePrompt}

      ## 2. The Fact Sheet (NOT a style guide)
      The "Raw Script" you will receive is just a list of facts. It is **NOT** a style guide. Its "friendly" or "corporate" tone is **WRONG** and must be **COMPLETELY DISCARDED**.

      ## 3. Your Task & Rules (MANDATORY)

      **CRITICAL RULE 1: MIMIC THE VOICE, NOT THE TOPIC.**
      - Your output MUST match the **pacing, sentence structure, word choice, and personality** of the "Creator's Voice Profile" examples.
      - If the Profile uses "Hey friends," you use "Hey friends."
      - If the Profile uses "Like, really small," you use that *kind* of informal language.
      - You are **FORBIDDEN** from using generic AI filler ("Let's dive in," "In conclusion," "It's a powerful insight," "game-changer").

      **CRITICAL RULE 2: PRESERVE THE FACTS.**
      - You **MUST** keep all facts, names, statistics (like "92%"), and the core structural points (e.g., "Principle #1") from the "Fact Sheet."
      - Do **NOT** add any new information, stories, or facts.

      **CRITICAL RULE 3: PRODUCE OUTPUT.**
      - Return ONLY the final, polished script.
      - Do NOT add any preamble.
    `;
    
    // --- Groq API Call ---
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: rawScript } // This is the "Fact Sheet"
      ],
      model: 'llama-3.3-70b-versatile',
    });

    const polishedText = chatCompletion.choices[0]?.message?.content.trim();
    if (!polishedText) throw new Error("No response from AI");

    // ... (rest of the /polish endpoint is the same)
    const { data: history, error: historyError } = await supabase
      .from('polish_history')
      .insert({
        user_id: userId,
        raw_script: rawScript,
        ai_polished_script: polishedText 
      })
      .select('id')
      .single();

    if (historyError) {
      console.error("Error saving polish history:", historyError);
    }

    res.json({ 
      polishedScript: polishedText,
      historyId: history ? history.id : null 
    });

  } catch (error) {
    console.error('Error from Groq (/polish):', error);
    res.status(500).json({ error: 'Failed to polish script' });
  }
});


// ---===================================---
// --- V3 SAVE & LEARN ENDPOINT (No changes)
// ---===================================---
app.post('/save-correction', async (req, res) => {
  try {
    const { 
      userId, 
      historyId, 
      aiPolishedScript, 
      userFinalScript 
    } = req.body;

    if (!userId || !historyId || !aiPolishedScript || !userFinalScript) {
      return res.status(400).json({ error: 'Missing data for learning' });
    }

    const editDistance = levenshtein(aiPolishedScript, userFinalScript);
    const qualityScore = Math.min(100, Math.round((editDistance / aiPolishedScript.length) * 1000));
    const topic = await analyzeTopicCategory(userFinalScript);
    
    const { data: example, error: exampleError } = await supabase
      .from('voice_examples')
      .insert({
        user_id: userId,
        script_text: userFinalScript,
        topic_category: topic,
        quality_score: qualityScore,
        word_count: userFinalScript.split(' ').length
      })
      .select('id')
      .single();

    if (exampleError) throw exampleError;

    await supabase
      .from('polish_history')
      .update({ 
        user_final_script: userFinalScript,
        voice_example_id: example.id 
      })
      .eq('id', historyId)
      .eq('user_id', userId); 

    res.json({ 
      message: 'Learning saved successfully', 
      newExampleId: example.id,
      newQualityScore: qualityScore,
      newTopic: topic
    });

  } catch (error) {
    console.error('Error in /save-correction:', error);
    res.status(500).json({ error: 'Failed to save correction' });
  }
});


// Start the server
app.listen(port, () => {
  console.log(`ScriptPolish AI server (V3.1 - Mimicry Engine) listening on http://localhost:${port}`);
});