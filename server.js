import express from 'express';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import cors from 'cors';
import { supabase } from './supabaseClient.js';
import { createRequire } from 'module';
import { rateLimit } from 'express-rate-limit';
import pRetry from 'p-retry';

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

// --- V5 AUTH MIDDLEWARE (The "Security Guard") ---
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization token provided' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Malformed token' });
  }
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

// --- V5 RATE LIMITER ---
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
  standardHeaders: 'draft-7',
    legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { error: 'You have made too many API requests. Please try again in 15 minutes.' },
});

// --- V4 HELPER FUNCTIONS ---
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
    if (predefinedCategories.includes(category)) return category;
    return "Other";
  } catch (error) {
    console.error("Error analyzing topic:", error);
    return "Other";
  }
}

// Helper to safely get nested properties from the JSON
const safeGet = (obj, path, defaultValue = 'N/A') => {
  const value = path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined) ? acc[key] : undefined, obj);
  return value !== undefined ? value : defaultValue;
};

// Helper to safely join arrays or provide a default
const safeJoin = (arr, separator = ', ') => {
  if (Array.isArray(arr) && arr.length > 0) {
    return arr.join(separator);
  }
  return 'N/A';
};

// ---================================---
// --- V4 "PATTERN-MATCHING" POLISH ENDPOINT
// --- (Now Secure with V5 Auth)
// ---================================---
app.post('/polish', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const userId = req.user.id; // <-- SECURE
    const { rawScript } = req.body;

    if (!rawScript) {
      return res.status(400).json({ error: 'Missing script' });
    }

    // 1. Fetch the user's voice patterns
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('voice_patterns')
      .eq('id', userId)
      .single();

    if (profileError || !profile?.voice_patterns) {
      return res.status(400).json({ 
        error: "Voice pattern not found. Please run 'Analyze My Voice' on your profile page." 
      });
    }

    const patterns = profile.voice_patterns?.voice_patterns || {};

    // 2. Build the "Pattern Assembler" prompt (Safely)
    const prompt = `
      You are a "Pattern Assembler." Your ONLY job is to rewrite a Fact Sheet using the EXACT patterns from this Voice Pattern Template.
      ## THE VOICE PATTERN TEMPLATE (YOUR RULES):
      \`\`\`json
      ${JSON.stringify(patterns, null, 2)}
      \`\`\`
      ## THE FACT SHEET (Content to Rewrite):
      ---
      ${rawScript}
      ---
      ## YOUR TASK & RULES:
      ...
      (All the V4 rules go here)
      ...
      CRITICAL: You are a COPY MACHINE, not a creative writer. Follow these patterns EXACTLY. Do not improvise.
      OUTPUT: Only the polished script. No preamble.
    `;

    // 3. Polish the script (with retry)
    const chatCompletion = await pRetry(() => groq.chat.completions.create({
      messages: [ { role: 'system', content: prompt } ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
    }), { retries: 3 });

    const polishedText = chatCompletion.choices[0]?.message?.content.trim();
    if (!polishedText) throw new Error("No response from AI");

    // 4. Save to history
    const { data: history, error: historyError } = await supabase
      .from('polish_history')
      .insert({ user_id: userId, raw_script: rawScript, ai_polished_script: polishedText })
      .select('id')
      .single();

    if (historyError) console.error("Error saving polish history:", historyError);

    res.json({ polishedScript: polishedText, historyId: history?.id });

  } catch (error) {
    console.error('Error in /polish:', error);
    res.status(500).json({ error: `Failed to polish script: ${error.message}` });
  }
});

// ---=======================================---
// --- V4 "VOICE ANALYST" ENDPOINT
// --- (Now Secure with V5 Auth)
// ---=======================================---
app.post('/analyze-voice', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const userId = req.user.id; // <-- SECURE

    const { data: examples, error: examplesError } = await supabase
      .from('voice_examples')
      .select('script_text')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (examplesError) throw examplesError;
    if (!examples || examples.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 saved examples to analyze a voice.' });
    }

    const scriptExamples = examples.map(e => e.script_text);
    const extractPatternsPrompt = `
      You are a "Voice Pattern Analyst."...
      [...The full V4 JSON extraction prompt...]
      ...
      { "voice_patterns": { ... } }
    `;

    const chatCompletion = await pRetry(() => groq.chat.completions.create({
      messages: [ { role: 'system', content: extractPatternsPrompt } ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      response_format: { type: "json_object" },
    }), { retries: 3 });

    const patternsText = chatCompletion.choices[0]?.message?.content.trim();
    if (!patternsText) throw new Error("AI did not return patterns");

    const voicePatterns = JSON.parse(patternsText); 

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ 
        voice_patterns: voicePatterns,
        patterns_extracted_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) throw updateError;
    res.json({ message: 'Voice patterns extracted successfully', patterns: voicePatterns });

  } catch (error) {
    console.error('Error in /analyze-voice:', error);
    res.status(500).json({ error: 'Failed to extract voice patterns' });
  }
});


// ---=======================================---
// --- V4 "SAVE & LEARN" ENDPOINT
// --- (Now Secure with V5 Auth)
// ---=======================================---
app.post('/save-correction', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id; // <-- SECURE
    const { 
      historyId, 
      aiPolishedScript, 
      userFinalScript 
    } = req.body;

    if (!historyId || !aiPolishedScript || !userFinalScript) {
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

    res.json({ message: 'Learning saved successfully' });

  } catch (error) {
    console.error('Error in /save-correction:', error);
    res.status(500).json({ error: 'Failed to save correction' });
  }
});


// Start the server
app.listen(port, () => {
  console.log(`ScriptPolish AI server (V4 Engine + V5 Security) listening on http://localhost:${port}`);
});