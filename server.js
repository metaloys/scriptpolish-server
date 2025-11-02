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
// --- V4 HELPER FUNCTIONS (No changes)
// ---================================---

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

// ---================================---
// --- V4 POLISH ENDPOINT (THE FIX)
// ---================================---
app.post('/polish', async (req, res) => {
  try {
    const { rawScript, userId } = req.body;
    
    if (!rawScript || !userId) {
      return res.status(400).json({ error: 'Missing script or user ID' });
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

    // This is the JSON object from your database
    const voicePatterns = profile.voice_patterns;
    // This is the nested object with the actual rules
    const patterns = voicePatterns.voice_patterns; 

    // 2. Build the "Pattern Assembler" prompt (THE FIX)
    // We now build the prompt directly, without complex regex.
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

      **RULE 1: OPENINGS**
      - You MUST start with one of these exact phrases: ${patterns.openings.common_phrases.join(' OR ')}
      - Follow this structure: ${patterns.openings.structure}

      **RULE 2: TRANSITIONS**
      - Between main points, use ONLY these: ${patterns.transitions.between_points.join(', ')}
      - You are FORBIDDEN from using: "Firstly," "Secondly," "Moreover," "Furthermore," "In conclusion"

      **RULE 3: SENTENCE STRUCTURE**
      - Average sentence length: ${patterns.sentence_structure.avg_length_words} words
      - ${patterns.sentence_structure.uses_fragments ? 'You MUST use sentence fragments' : 'Avoid fragments'}
      - ${patterns.sentence_structure.uses_questions ? 'You MUST include rhetorical questions' : 'Avoid questions'}

      **RULE 4: EMPHASIS**
      - Sprinkle in these interjections: ${patterns.emphasis_techniques.casual_interjections.join(', ')}

      **RULE 5: VOCABULARY**
      - Formality level: ${patterns.vocabulary.formality_level}
      - Prefer these verbs: ${patterns.vocabulary.common_verbs.join(', ')}
      - NEVER use: ${patterns.vocabulary.avoid_words.join(', ')}

      **RULE 6: PACING**
      - Paragraphs should be ~${patterns.pacing.paragraph_length_sentences} sentences.
      - ${patterns.pacing.uses_single_sentence_paragraphs ? 'Use single-sentence paragraphs for emphasis' : ''}

      **RULE 7: PERSONALITY**
      - Reference yourself like: ${patterns.personality_markers.self_reference.join(', ')}
      - Address audience as: ${patterns.personality_markers.direct_address.join(', ')}

      **CRITICAL:** You are a COPY MACHINE, not a creative writer. Follow these patterns EXACTLY. Do not improvise.

      OUTPUT: Only the polished script. No preamble.
    `;
    
    // 3. Polish the script
    const chatCompletion = await groq.chat.completions.create({
      messages: [ { role: 'system', content: prompt } ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
    });

    const polishedText = chatCompletion.choices[0]?.message?.content.trim();
    if (!polishedText) throw new Error("No response from AI");

    // 4. Save to history
    const { data: history, error: historyError } = await supabase
      .from('polish_history')
      .insert({
        user_id: userId,
        raw_script: rawScript,
        ai_polished_script: polishedText,
      })
      .select('id')
      .single();
      
    if (historyError) {
      console.error("Error saving polish history:", historyError);
    }

    res.json({ 
      polishedScript: polishedText,
      historyId: history?.id 
    });

  } catch (error) {
    console.error('Error in /polish:', error);
    // Send a more specific error message back to the frontend
    res.status(500).json({ error: `Failed to polish script: ${error.message}` });
  }
});


// ---=======================================---
// --- V4 ENDPOINT 2: ANALYZE VOICE (No changes)
// ---=======================================---
app.post('/analyze-voice', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

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
      You are a "Voice Pattern Analyst." Your job is to study these scripts and extract CONCRETE, MEASURABLE patterns that define the creator's unique voice.

      ## THE SCRIPTS TO ANALYZE:
      ---
      ${scriptExamples.join('\n\n---\n\n')}
      ---

      ## YOUR TASK:
      Analyze these scripts and return a JSON object with the following structure. Be SPECIFIC and CONCRETE.

      1. **OPENINGS:**
         - What are the exact phrases used to start videos? (List 3-5 examples)
         - What is the typical structure? (e.g., "greeting + topic intro + hook (stat or question)")
         - Average length in words?

      2. **TRANSITIONS:**
         - Between main points: What words/phrases connect sections? (List 5-10)
         - Within sections: How does the creator move between ideas?
         - To examples: How are examples introduced?

      3. **SENTENCE STRUCTURE:**
         - Average sentence length in words?
         - Does the creator use sentence fragments? (yes/no)
         - Does the creator use rhetorical questions? (yes/no)
         - What % of sentences are under 10 words?

      4. **EMPHASIS TECHNIQUES:**
         - What casual interjections does the creator use? ("Honestly,", "Look,", etc.)
         - What intensifiers? ("really", "super", "way more")

      5. **VOCABULARY:**
         - Formality level: (academic, professional, casual_friend, or very_casual)
         - Does the creator use academic jargon? (minimal, moderate, frequent)
         - List 5-10 common action verbs
         - List 5-10 words the creator NEVER uses (formal words to avoid)

      6. **PACING:**
         - Average paragraph length in sentences?
         - Does the creator use single-sentence paragraphs? (yes/no)

      7. **CONCLUSIONS:**
         - What are the exact sign-off phrases? (List 2-5)
         - Typical structure?

      8. **PERSONALITY MARKERS:**
         - How does the creator reference themselves? ("I", "For me", "When I was")
         - How does the creator address the audience? ("you", "you guys", "friends")
         - Does the creator show vulnerability or share failures? (yes/no with examples)

      ## OUTPUT FORMAT:
      Return ONLY valid JSON. No preamble. Use this exact structure:

      {
        "voice_patterns": {
          "openings": { ... },
          "transitions": { ... },
          "sentence_structure": { ... },
          "emphasis_techniques": { ... },
          "vocabulary": { ... },
          "pacing": { ... },
          "conclusions": { ... },
          "personality_markers": { ... }
        }
      }
    `;

    const chatCompletion = await groq.chat.completions.create({
      messages: [ { role: 'system', content: extractPatternsPrompt } ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

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

    res.json({ 
      message: 'Voice patterns extracted successfully',
      patterns: voicePatterns 
    });

  } catch (error) {
    console.error('Error in /analyze-voice:', error);
    res.status(500).json({ error: 'Failed to extract voice patterns' });
  }
});


// ---=======================================---
// --- V4 ENDPOINT 3: SAVE CORRECTION (No changes)
// ---=======================================---
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
  console.log(`ScriptPolish AI server (V4.1 - Safe Polish) listening on http://localhost:${port}`);
});