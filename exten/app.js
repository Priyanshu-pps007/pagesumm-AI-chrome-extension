// Import the PDF.js module from the local lib folder
import * as pdfjsLib from "./lib/pdf.min.mjs";

// Import the new chat module
import { initializeChat, renderChatMemory } from "./chat.js";

// Set worker source for pdf.js to the local file
// Make sure 'lib/pdf.worker.min.mjs' exists in your /lib folder
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

// === Element Selection === (Done after DOM ready)
// These will be assigned in DOMContentLoaded

// === State & Constants ===
const KNOWLEDGE_CHUNKS_KEY = 'pagesumm_knowledge_chunks_v2'; // For raw text chunks (Knowledgebase)
const LAST_SUMMARY_KEY = 'pagesumm_last_summary_v2'; // For the top summary box (optional preview)
const CHAT_MEMORY_KEY = 'pagesumm_chat_history_v2'; // For chat history

let summarizer = null;
let currentChunks = []; // In-memory cache for knowledgebase chunks
let currentSummary = ''; // In-memory cache for last summary (display box)
let elements = {}; // To store DOM elements

// === Utility Functions ===
function setStatus(msg) {
  elements.statusBar.innerText = msg;
  console.log('[PageSumm]', msg);
}

// === Action Buttons ===
function attachButtonListeners() {
  elements.copySummaryBtn.addEventListener('click', async () => {
    if (!currentSummary) return;
    try {
      await navigator.clipboard.writeText(currentSummary);
      setStatus('Summary copied to clipboard');
    } catch (err) {
      console.warn('Clipboard API failed.', err);
      setStatus('Failed to copy summary.');
    }
  });

  elements.clearMemoryBtn.addEventListener('click', () => {
    localStorage.removeItem(CHAT_MEMORY_KEY);
    localStorage.removeItem(LAST_SUMMARY_KEY);
    localStorage.removeItem(KNOWLEDGE_CHUNKS_KEY);
    elements.summaryOutput.innerText = '';
    elements.conversationList.innerHTML = ''; // Clear chat UI
    elements.textInput.value = '';
    currentChunks = [];
    currentSummary = '';
    elements.useKnowledgebase.checked = false; // Reset toggle
    setStatus('All memory and context cleared.');
  });

  elements.downloadModelBtn.addEventListener('click', async () => {
    try {
      setStatus('Checking summarizer...');
      await ensureSummarizer();
      setStatus('Summarizer model is ready (for previews).');
    } catch (err) {
      console.warn(err);
      setStatus('Model setup failed: ' + (err.message || err));
    }
  });

  elements.expandBtn.addEventListener('click', () => {
    try {
      const url = chrome.runtime.getURL('index.html');
      chrome.tabs.create({ url });
    } catch (err) {
      console.error("Expand button failed:", err);
      setStatus("Could not open new tab. Reload extension?");
    }
  });
}

// === Core AI Functions (Summarizer) ===
async function ensureSummarizer() {
  if (!('Summarizer' in self)) {
    throw new Error('Summarizer API not available in this browser');
  }

  const availability = await Summarizer.availability();
  if (availability === 'unavailable') {
    throw new Error('Summarizer models unavailable');
  }

  if (!summarizer) {
    // Creating the model requires a user gesture in some browsers.
    if (!navigator.userActivation || !navigator.userActivation.isActive) {
      throw new Error('User interaction required. Click "Ensure model"');
    }

    setStatus('Loading summarizer model...');
    const options = {
      // We will set type/length on each call
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          setStatus(`Model download: ${(e.loaded * 100).toFixed(1)}%`);
        });
      },
    };

    summarizer = await Summarizer.create(options);
    setStatus('Summarizer ready');
  }

  return summarizer;
}

// === Hierarchical Summarization for Active Tab (Parallel) ===
async function generateHierarchicalSummary(chunks) {
  try {
    const summarizerInstance = await ensureSummarizer();

    // Step 1: Summarize each chunk in parallel using Promise.all
    setStatus('Summarizing chunks in parallel...');
    const summarizeChunk = async (chunk, index) => {
      try {
        setStatus(`Processing chunk ${index + 1}...`); // Update status for progress
        const chunkSummary = await summarizerInstance.summarize(chunk, {
          context: 'Summarize the key points from this text chunk concisely.',
          length: 'short',
          type: elements.summaryType.value || 'paragraph'
        });
        return typeof chunkSummary === 'string' ? chunkSummary : (chunkSummary?.summary || chunk.slice(0, 200) + '...');
      } catch (err) {
        console.warn(`Failed to summarize chunk ${index}:`, err);
        // Fallback: Short preview without labels
        return chunk.slice(0, 300) + '...';
      }
    };

    const chunkSummariesPromises = chunks.map((chunk, index) => summarizeChunk(chunk, index));
    const chunkSummaries = await Promise.all(chunkSummariesPromises);

    // Step 2: Combine all chunk summaries cleanly (no labels, just content)
    const combinedSummaries = chunkSummaries.join('\n\n');

    // Step 3: Summarize the combined summaries (final summary)
    setStatus('Generating final summary...');
    const finalSummary = await summarizerInstance.summarize(combinedSummaries, {
      context: 'Provide a comprehensive yet concise summary of the entire document based on these summaries.',
      length: elements.summaryLength.value || 'medium',
      type: elements.summaryType.value || 'paragraph'
    });
    const finalText = typeof finalSummary === 'string' ? finalSummary : (finalSummary?.summary || combinedSummaries.slice(0, 1000));

    return finalText;
  } catch (err) {
    console.error('Hierarchical summarization failed:', err);
    // Fallback: Combine short previews of chunks (no labels)
    const fallback = chunks.map(chunk => chunk.slice(0, 300) + '...').join('\n\n');
    return `Summarization error. Preview:\n${fallback.slice(0, 1500)}`;
  }
}

// === Text Processing & Chunking ===
function chunkText(text, maxChars = 15000) { // Using 15k chars, ~2500-3000 words
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n{2,}/g);
  const chunks = [];
  let current = '';

  for (const p of paragraphs) {
    if ((current.length + p.length + 2) <= maxChars) {
      current += (current ? '\n\n' : '') + p;
    } else {
      if (current) chunks.push(current);

      if (p.length > maxChars) {
        // Fallback: split very long paragraphs by sentence
        const sentences = p.match(/[^\.!?]+[\.!?]+/g) || [p];
        let scur = '';
        for (const s of sentences) {
          if ((scur.length + s.length) <= maxChars) {
            scur += s;
          } else {
            if (scur) chunks.push(scur);
            scur = s;
          }
        }
        if (scur) chunks.push(scur);
        current = '';
      } else {
        current = p;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function extractRelevantTextFromHTML(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  // Selectors for common content areas
  const selectors = ['article', 'main', 'section', 'p', 'b','h1', 'h2', 'h3', 'h4', 'li', 'blockquote','span'];
  const nodes = [];

  selectors.forEach(sel => {
    doc.querySelectorAll(sel).forEach(n => {
      const t = n.innerText && n.innerText.trim();
      if (t && t.length > 20) nodes.push(t); // Only grab meaningful text
    });
  });

  // Fallback if no specific tags found
  if (nodes.length === 0) {
    const t = doc.body ? doc.body.innerText : '';
    if (t && t.trim().length > 0) nodes.push(t.trim());
  }

  // De-duplicate and join
  const uniq = Array.from(new Set(nodes));
  return uniq.join('\n\n');
}

// === Knowledgebase Storage Functions ===
function storeChunks(chunks, skipPreview = false) {
  currentChunks = chunks;
  localStorage.setItem(KNOWLEDGE_CHUNKS_KEY, JSON.stringify(chunks));
  if (!skipPreview && chunks.length > 0) {
    // Only set a simple preview if not in hierarchical mode
    const preview = chunks[0].slice(0, 500) + (chunks[0].length > 500 ? "..." : "");
    currentSummary = `[Knowledgebase Loaded - Please wait`;
    elements.summaryOutput.innerText = currentSummary;
    localStorage.setItem(LAST_SUMMARY_KEY, currentSummary);
  }
  elements.useKnowledgebase.checked = chunks.length > 0;
  setStatus(`Knowledgebase loaded with ${chunks.length} chunks.`);
}

function getChunks() {
  return currentChunks;
}

// === Event Listeners for Knowledgebase Loading ===
// These will be attached after elements are selected

function attachKnowledgeListeners() {
  // 1. Load Active Tab (with hierarchical summarization, no temporary display)
  elements.summarizePageBtn.addEventListener('click', async () => {
    try {
      setStatus('Reading active tab...');
      elements.summaryOutput.innerText = 'Generating summary...'; // Clear and show loading
      const rawHtml = await fetchPageFromActiveTab();
      const extractedText = extractRelevantTextFromHTML(rawHtml);
      setStatus(`Extracted ${extractedText.length} characters.`);

      if (extractedText) {
        const chunks = chunkText(extractedText);
        // Store raw chunks silently (skip preview to avoid temporary display)
        storeChunks(chunks, true);
        // Generate and display hierarchical summary only at the end
        const finalSummary = await generateHierarchicalSummary(chunks);
        currentSummary = finalSummary;
        elements.summaryOutput.innerText = finalSummary;
        localStorage.setItem(LAST_SUMMARY_KEY, finalSummary);
        setStatus(`Summary complete (${finalSummary.length} chars). Knowledgebase ready.`);
      } else {
        elements.summaryOutput.innerText = '';
        setStatus('No text extracted from page.');
      }
    } catch (err) {
      console.error(err);
      elements.summaryOutput.innerText = '';
      setStatus('Error: ' + (err.message || 'Failed to get page content'));
    }
  });

  // 2. Load Pasted Text (raw chunks to KB, simple preview)
  elements.summarizeTextBtn.addEventListener('click', async () => {
    const text = elements.textInput.value.trim();
    if (!text) {
      setStatus('Please paste some text first.');
      return;
    }

    const chunks = chunkText(text);
    storeChunks(chunks);

    // Summarize pasted text robustly. Use hierarchical approach when useful.
    try {
      let summarized_text = '';

      // Attempt to use the Summarizer model (this is a user-initiated click -> allowed)
      try {
        const summarizerInstance = await ensureSummarizer();

        if (chunks.length > 1) {
          // For multi-chunk input, use hierarchical pipeline already implemented.
          summarized_text = await generateHierarchicalSummary(chunks);
        } else {
          // Single chunk -> do a direct summarize call
          const raw = await summarizerInstance.summarize(text, {
            context: 'Summarize the key points from this text concisely.',
            length: elements.summaryLength.value || 'short',
            type: elements.summaryType.value || 'paragraph'
          });
          summarized_text = typeof raw === 'string' ? raw : (raw?.summary || text.slice(0, 1000));
        }
      } catch (innerErr) {
        console.warn('Summarizer not available or failed for pasted text:', innerErr);
        // Fallback: create a simple preview-based "summary" from the first few chunks
        if (chunks.length > 0) {
          summarized_text = chunks.slice(0, 3).map(c => c.slice(0, 800)).join('\n\n');
          if (summarized_text.length > 1500) summarized_text = summarized_text.slice(0, 1500) + '...';
        } else {
          summarized_text = text.slice(0, 1000) + (text.length > 1000 ? '...' : '');
        }
      }

      // Display and persist the summary
      currentSummary = summarized_text;
      elements.summaryOutput.innerText = currentSummary;
      localStorage.setItem(LAST_SUMMARY_KEY, currentSummary);
      setStatus(`Pasted text summarized (${currentSummary.length} chars).`);

    } catch (err) {
      console.error('Error while summarizing pasted text:', err);
      setStatus('Failed to summarize pasted text: ' + (err.message || err));
    }
  });

}

// Helper to get tab HTML
async function fetchPageFromActiveTab() {
  const tabs = await new Promise((resolve, reject) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime && chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(tabs);
      });
    } catch (e) { reject(e); }
  });
  const tab = (tabs && tabs[0]) || null;
  if (!tab) throw new Error('No active tab found');

  if (typeof chrome.scripting !== 'undefined') {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.documentElement.outerHTML
      });
      const finalHtml = (results && results[0] && results[0].result) || '';
      if (!finalHtml) throw new Error('Failed to read page DOM (empty result)');
      return finalHtml;
    } catch (execErr) {
      console.error('scripting.executeScript failed', execErr);
      throw new Error('Cannot read this page (Restricted URL or permission issue)');
    }
  } else {
    throw new Error('Scripting API unavailable');
  }
}

async function extractPdfText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = Math.min(pdf.numPages, 5); // Limit to 5 pages
  let fullText = '';

  for (let i = 1; i <= numPages; i++) {
    setStatus(`Reading PDF page ${i} of ${numPages}...`);
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    fullText += textContent.items.map(item => item.str).join(' ') + '\n\n';
  }

  return fullText;
}

// Restore state on popup load
function restoreStateOnLoad() {
  renderChatMemory(); // Load chat history (from chat.js)

  const lastSummary = localStorage.getItem(LAST_SUMMARY_KEY);
  if (lastSummary) {
    elements.summaryOutput.innerText = lastSummary;
    currentSummary = lastSummary;
    setStatus('Restored knowledgebase preview.');
  } else {
    setStatus('Load a page, text, or file to build knowledgebase.');
  }

  // Restore knowledgebase chunks
  const chunksJson = localStorage.getItem(KNOWLEDGE_CHUNKS_KEY);
  if (chunksJson) {
    currentChunks = JSON.parse(chunksJson);
    elements.useKnowledgebase.checked = currentChunks.length > 0;
    setStatus('Restored knowledgebase with chunks.');
  } else {
    elements.useKnowledgebase.checked = false;
  }
}

// === APP INITIALIZATION ===
document.addEventListener('DOMContentLoaded', () => {
  // Select elements now that DOM is ready
  elements = {
    summarizePageBtn: document.getElementById('summarizePageBtn'),
    textInput: document.getElementById('textInput'),
    summarizeTextBtn: document.getElementById('summarizeTextBtn'),
    // fileInput: document.getElementById('fileInput'),
    fileName: document.getElementById('fileName'),
    summaryType: document.getElementById('summaryType'),
    summaryLength: document.getElementById('summaryLength'),
    expandBtn: document.getElementById('expandBtn'),
    statusBar: document.getElementById('statusBar'),
    downloadModelBtn: document.getElementById('downloadModelBtn'),
    summaryOutput: document.getElementById('summaryOutput'),
    copySummaryBtn: document.getElementById('copySummary'),
    clearMemoryBtn: document.getElementById('clearMemory'),
    useKnowledgebase: document.getElementById('useKnowledgebase'),
    askBtn: document.getElementById('askBtn'),
    userQuestion: document.getElementById('userQuestion'),
    conversationList: document.getElementById('conversationList')
  };

  // Check if key elements exist
  if (!elements.askBtn || !elements.userQuestion || !elements.conversationList) {
    console.error('Critical DOM elements missing. Check index.html.');
    setStatus('UI elements not found. Reload extension.');
    return;
  }

  // Attach all listeners
  attachButtonListeners();
  attachKnowledgeListeners();

  // 1. Restore previous state
  restoreStateOnLoad();

  // 2. Initialize the chat module and pass dependencies
  initializeChat({
    // Pass the setStatus function
    setStatus,
    // Pass a function to get the current knowledgebase chunks
    getKnowledgebaseChunks: () => currentChunks,
    // Pass the DOM elements the chat module needs
    elements: {
      askBtn: elements.askBtn,
      userQuestion: elements.userQuestion,
      conversationList: elements.conversationList,
      useKnowledgebase: elements.useKnowledgebase
    }
  });

  console.log('App initialized successfully.');
});
