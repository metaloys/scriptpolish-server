import express from 'express';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import cors from 'cors';
import { supabase } from './supabaseClient.js'; // We now need the Supabase admin client
import levenshtein from 'levenshtein-edit-distance'; // The diff library we just installed

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
// Increase the JSON payload limit to handle large scripts
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
      model: 'llama-3.1-8b-instant', // Use the fastest model for this simple task
    });

    const category = chatCompletion.choices[0]?.message?.content.trim() || "Other";
    
    // Final check to make sure it's a valid category
    if (predefinedCategories.includes(category)) {
      return category;
    }
    return "Other";
  } catch (error) {
    console.error("Error analyzing topic:", error);
    return "Other"; // Default to "Other" on failure
  }
}

// Helper 2: Select the 5 most relevant examples
async function selectBestExamples(userId, topic) {
  // This is the "Smart Curation" query
  // It prefers examples of the same topic, then highest quality, then most recent
  const { data, error } = await supabase
    .from('voice_examples')
    .select('script_text')
    .eq('user_id', userId)
    .order('topic_category', { ascending: topic !== 'Other' }) // Prioritize the matching topic
    .order('quality_score', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error("Error selecting best examples:", error);
    return []; // Return empty array on error
  }
  
  return data.map(row => row.script_text);
}

// ---================================---
// --- V3 POLISH ENDPOINT (UPGRADED)
// ---================================---
app.post('/polish', async (req, res) => {
  try {
    const { rawScript, userId } = req.body;
    if (!rawScript || !userId) {
      return res.status(400).json({ error: 'Missing script or user ID' });
    }

    // 1. Analyze the topic of the *new* script
    const scriptTopic = await analyzeTopicCategory(rawScript);

    // 2. Select the 5 best *existing* examples for that topic
    const relevantExamples = await selectBestExamples(userId, scriptTopic);

    const stylePrompt = relevantExamples.length > 0
      ? `
        ## 1. The Creator's Voice Profile (THE AUTHORITY)
        Study these ${relevantExamples.length} "gold-standard" examples of the creator's voice. This is the *only* voice, tone, and pacing you are allowed to use.
        **Examples:**
        ---
        ${relevantExamples.join('\n\n---\n\n')}
        ---
      `
      : `
        ## 1. The Creator's Voice Profile
        No style examples found for this user. Polish using a standard, engaging, and clear YouTube video script style.
      `;

    // 3. Build the final prompt (same rules as before)
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
    
    // 4. Call Groq to polish the script
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: rawScript }
      ],
      model: 'llama-3.3-70b-versatile',
    });

    const polishedText = chatCompletion.choices[0]?.message?.content.trim();
    if (!polishedText) throw new Error("No response from AI");

    // 5. Save a record to the new `polish_history` table
    const { data: history, error: historyError } = await supabase
      .from('polish_history')
      .insert({
        user_id: userId,
        raw_script: rawScript,
        ai_polished_script: polishedText 
      })
      .select('id') // Return the ID of the new history row
      .single();

    if (historyError) {
      console.error("Error saving polish history:", historyError);
      // Don't block the user, just log the error
    }

    // 6. Send the polish *and* the history ID back to the app
    res.json({ 
      polishedScript: polishedText,
      historyId: history ? history.id : null // The app will need this to "save & learn"
    });

  } catch (error) {
    console.error('Error from Groq (/polish):', error);
    res.status(500).json({ error: 'Failed to polish script' });
  }
});


// ---===================================---
// --- V3 SAVE & LEARN ENDPOINT (NEW)
// ---===================================---
app.post('/save-correction', async (req, res) => {
  try {
    const { 
      userId, 
      historyId, // The ID of the polish we are correcting
      aiPolishedScript, 
      userFinalScript 
    } = req.body;

    if (!userId || !historyId || !aiPolishedScript || !userFinalScript) {
      return res.status(400).json({ error: 'Missing data for learning' });
    }

    // 1. Calculate Quality Score (as "Mark" designed)
    const editDistance = levenshtein(aiPolishedScript, userFinalScript);
    // This is a simple formula: score = (percent_changed * 10).
    // A 100% edit (max quality) = 100. A 10% edit = 10.
    const qualityScore = Math.min(100, Math.round((editDistance / aiPolishedScript.length) * 1000));
    
    // 2. Get the topic for the new script
    const topic = await analyzeTopicCategory(userFinalScript);
    
    // 3. Save the *new* human-corrected script to the voice profile
    const { data: example, error: exampleError } = await supabase
      .from('voice_examples')
      .insert({
        user_id: userId,
        script_text: userFinalScript,
        topic_category: topic,
        quality_score: qualityScore,
        word_count: userFinalScript.split(' ').length
      })
      .select('id') // Return the ID of the new example
      .single();

    if (exampleError) throw exampleError;

    // 4. Update the history record to link to the new example
    await supabase
      .from('polish_history')
      .update({ 
        user_final_script: userFinalScript,
        voice_example_id: example.id 
      })
      .eq('id', historyId)
      .eq('user_id', userId); // RLS policy check

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
  console.log(`ScriptPolish AI server (V3.0 - Smart Curation) listening on http://localhost:${port}`);
});