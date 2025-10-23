// === State & Constants ===
const CHAT_MEMORY_KEY = 'pagesumm_chat_history_v2';

let languageSession = null;
let chatSetStatus = (msg) => console.log(msg); // Placeholder
let getKnowledgebaseChunks = () => []; // Placeholder for chunks
let chatElements = {}; // Placeholder for DOM elements

/**
 * Initializes the chat module and dependencies.
 * @param {object} deps - Dependencies from app.js
 * @param {function} deps.setStatus - Function to update status bar
 * @param {function} deps.getKnowledgebaseChunks - Function to get current knowledgebase chunks
 * @param {object} deps.elements - DOM elements for chat
 */
export function initializeChat(deps) {
  chatSetStatus = deps.setStatus;
  getKnowledgebaseChunks = deps.getKnowledgebaseChunks;
  chatElements = deps.elements;

  console.log('Chat initialized. Elements:', chatElements);

  // Attach the Ask button listener
  if (chatElements.askBtn) {
    chatElements.askBtn.addEventListener('click', onAskBtnClick);
    console.log('Ask button listener attached.');
  } else {
    console.error('Ask button element not found.');
  }

  // Allow pressing Enter to ask
  if (chatElements.userQuestion) {
    chatElements.userQuestion.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // prevent newline
        onAskBtnClick();
      }
    });
  }

  const clearChatBtn = document.getElementById('clearChatBtn');
  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', onClearChatClick);
  } else {
    console.warn("Clear Chat button not found in the DOM.");
  }

  chatSetStatus('Chat ready. Ask a question!');
}

// === Core AI Function (LanguageModel) ===
async function ensureLanguageSession() {
  if (!('LanguageModel' in self)) {
    throw new Error('LanguageModel API not available');
  }

  const availability = await LanguageModel.availability();
  if (availability === 'unavailable') {
    throw new Error('LanguageModel unavailable');
  }

  if (!navigator.userActivation || !navigator.userActivation.isActive) {
    throw new Error('User interaction required. Click the "Ask" button');
  }

  if (!languageSession) {
    chatSetStatus('Loading language model...');
    languageSession = await LanguageModel.create({
      monitor(m) { m.addEventListener('downloadprogress', (e) => chatSetStatus(`Model download: ${(e.loaded * 100).toFixed(1)}%`)); }
    });
    chatSetStatus('LanguageModel session ready');
  }

  return languageSession;
}

// === Chat History (localStorage) ===
function loadMemory() {
  try {
    const raw = localStorage.getItem(CHAT_MEMORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { 
    console.error('Error loading chat memory:', e);
    return []; 
  }
}

function saveMemory(mem) {
  localStorage.setItem(CHAT_MEMORY_KEY, JSON.stringify(mem));
}

function pushMemory(item) {
  const mem = loadMemory();
  while (mem.length >= 10) { // Keep last 5 Q/A pairs (10 items)
    mem.shift();
  }
  mem.push(item);
  saveMemory(mem);
}

/**
 * Renders the chat history from localStorage into the list.
 * This is exported so app.js can call it on load.
 */
export function renderChatMemory() {
  const mem = loadMemory();
  // We must get the list element here, as it may not exist when module first loads
  const list = document.getElementById('conversationList');
  if (!list) {
    console.warn('Conversation list not found for rendering memory.');
    return;
  }

  list.innerHTML = '';
  const recent = mem.slice(Math.max(0, mem.length - 10));

  for (const e of recent) {
    const li = document.createElement('li');
    li.className = e.type === 'q' ? 'chat-q' : 'chat-a';
    if (e.type === 'a') {
      const answerEl = document.createElement('pre');
      answerEl.innerText = e.content;
      li.appendChild(answerEl);
    } else {
      li.innerText = e.content;
    }
    list.appendChild(li);
  }

  // Scroll to bottom after rendering history
  if(list.children.length > 0) {
    list.scrollTop = list.scrollHeight;
  }
}

// Simple keyword matching to find relevant chunks
function findRelevantChunks(question, chunks, topK = 2) {
  if (chunks.length === 0) return '';

  // Split question into words (simple tokenization)
  const questionWords = question.toLowerCase().split(/\s+/).filter(word => word.length > 2);

  if (questionWords.length === 0) {
    // If no meaningful words, return first two chunks
    return chunks.slice(0, topK).join('\n\n---\n\n');
  }

  // Score each chunk by number of matching words
  const scoredChunks = chunks.map((chunk, index) => {
    const chunkLower = chunk.toLowerCase();
    const matches = questionWords.filter(word => chunkLower.includes(word)).length;
    return { chunk, score: matches, index };
  });

  // Sort by score descending, then by index (for stability)
  scoredChunks.sort((a, b) => b.score - a.score || a.index - b.index);

  // Take top K, concatenate
  const topChunks = scoredChunks.slice(0, topK).map(item => item.chunk);
  return topChunks.join('\n\n---\n\n');
}

// === "Ask Anything" (Streaming Chat) ===
/**
 * Builds the prompt as a single string with relevant context if KB is enabled.
 */
function buildPrompt(question) {
  const systemPrompt = "You are a helpful AI assistant. Answer the user's question. If context is provided, use it to inform your answer. Be concise and helpful.\n\n";
  let fullPrompt = systemPrompt;

  // Check if the toggle is on
  if (chatElements.useKnowledgebase && chatElements.useKnowledgebase.checked) {
    const chunks = getKnowledgebaseChunks(); // Get chunks from app.js
    if (chunks.length > 0) {
      // Find top 2 relevant chunks
      const relevantContext = findRelevantChunks(question, chunks, 2);
      // Combine context and question
      fullPrompt += `Context from knowledgebase:\n${relevantContext}\n\nUser Question: ${question}`;
      console.log('Building prompt WITH relevant knowledgebase chunks.');
    } else {
      // Knowledgebase is ON but no chunks
      chatSetStatus('Knowledgebase is on, but no content is loaded.');
      fullPrompt += `User Question: ${question}`;
    }
  } else {
    // Knowledgebase is OFF
    fullPrompt += `User Question: ${question}`;
    console.log('Building prompt WITHOUT knowledgebase.');
  }

  return fullPrompt;
}

// Main click handler for the Ask button
async function onAskBtnClick() {
  console.log('Ask button clicked.');
  const q = (chatElements.userQuestion ? chatElements.userQuestion.value : '').trim();
  if (!q) {
    chatSetStatus('Please ask a question.');
    return;
  }

  let session;
  try {
    session = await ensureLanguageSession();
  } catch(err) {
    console.error('Error ensuring language session:', err);
    chatSetStatus('Error: ' + (err.message || 'Failed to start session'));
    return;
  }

  // Disable input while streaming
  if (chatElements.askBtn) chatElements.askBtn.disabled = true;
  if (chatElements.userQuestion) {
    chatElements.userQuestion.disabled = true;
    chatElements.userQuestion.value = '';
  }
  chatSetStatus('Thinking...');

  // 1. Create and append the User's Question block
  const qLi = document.createElement('li');
  qLi.className = 'chat-q';
  qLi.innerText = q;
  if (chatElements.conversationList) {
    chatElements.conversationList.appendChild(qLi);
    pushMemory({ type: 'q', content: q, ts: Date.now() });
    chatElements.conversationList.scrollTop = chatElements.conversationList.scrollHeight;
  }

  // 2. Create and append the AI's Answer block
  const aLi = document.createElement('li');
  aLi.className = 'chat-a';
  const answerEl = document.createElement('pre');
  answerEl.innerText = '...'; // Placeholder
  aLi.appendChild(answerEl);
  if (chatElements.conversationList) {
    chatElements.conversationList.appendChild(aLi);
    chatElements.conversationList.scrollTop = chatElements.conversationList.scrollHeight;
  }

  let fullAnswer = '';
  try {
    // 3. Build the prompt as string
    const prompt = buildPrompt(q);
    console.log('Prompt built:', prompt.substring(0, 200) + '...'); // Log first 200 chars
    // 4. Stream response
    const stream = await session.promptStreaming(prompt);

    // 5. Stream into the answer block
    for await (const chunk of stream) {
      console.log('Stream chunk:', chunk);
      fullAnswer += chunk;
      if (answerEl) {
        answerEl.innerText = fullAnswer;
        chatElements.conversationList.scrollTop = chatElements.conversationList.scrollHeight;
      }
    }

    chatSetStatus('Response complete.');
    // 6. Save the complete answer to memory
    pushMemory({ type: 'a', content: fullAnswer, ts: Date.now() });
  } catch (err) {
    console.error('Error in streaming:', err);
    const errorMsg = 'Error: ' + (err.message || 'Prompt failed');
    if (answerEl) answerEl.innerText = errorMsg;
    chatSetStatus('Error processing question.');
    pushMemory({ type: 'a', content: errorMsg, ts: Date.now() });
  } finally {
    // Re-enable input
    if (chatElements.askBtn) chatElements.askBtn.disabled = false;
    if (chatElements.userQuestion) {
      chatElements.userQuestion.disabled = false;
      chatElements.userQuestion.focus();
    }
  }
}

function onClearChatClick() {
  // Clear the UI
  if (chatElements.conversationList) {
    chatElements.conversationList.innerHTML = '';
  }

  // Clear the storage
  localStorage.removeItem(CHAT_MEMORY_KEY);

  // Update status
  chatSetStatus('Chat history cleared.');
}
