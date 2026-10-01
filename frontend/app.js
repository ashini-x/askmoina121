(() => {
  "use strict";

  const root = document.querySelector("#app");
  if (!root) return;

  const API_BASE_URL = String(window.ASKMOINA_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");
  const STORAGE_KEY = "askmoina.conversations.v3";
  const MODE_KEY = "askmoina.mode.v3";
  const MAX_HISTORY = 40;
  const MAX_MODEL_HISTORY_CHARS = 100000;
  const MAX_PROMPT_CHARS = 12000;
  const MODE_CONFIG = {
    logical: { temperature: 0, reasoning_effort: "high", verbosity: "medium" },
    auto: { temperature: 0.2, reasoning_effort: "high", verbosity: "medium" },
    creative: { temperature: 0.75, reasoning_effort: "medium", verbosity: "high" },
  };
  const PHRASES = [
    "Preparing Moina",
    "Researching current information",
    "Thinking through the problem",
    "Validating calculations and code",
    "Checking the answer independently",
    "Finishing your answer",
  ];
  const MODE_LABELS = { logical: "Logical", auto: "Auto", creative: "Creative" };

  const qs = (selector, scope = root) => scope?.querySelector(selector);
  const qsa = (selector, scope = root) => Array.from(scope?.querySelectorAll(selector) || []);

  const storedMode = (() => {
    try { return localStorage.getItem(MODE_KEY) || "auto"; } catch { return "auto"; }
  })();

  const state = {
    mode: MODE_CONFIG[storedMode] ? storedMode : "auto",
    messages: [],
    conversations: loadConversations(),
    activeConversationId: crypto.randomUUID(),
    controller: null,
    currentPhase: "idle",
    currentPrompt: "",
    responseText: "",
    responseHtml: "",
    currentSources: [],
    thoughtExpanded: new Set(),
    toastTimer: null,
    renderKey: "",
    followLatest: true,
    thinking: {
      stage: 0,
      desiredStage: 0,
      labels: [],
      playing: false,
      transitionTimer: null,
      settleTimer: null,
    },
  };

  const PHASE_TO_STAGE = {
    initializing: 0,
    searching: 1,
    synthesizing: 2,
    sandbox: 3,
    verifying: 4,
    finalizing: 5,
  };

  function loadConversations() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("askmoina.conversations.v2") || "[]";
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, 50).map((item) => ({
        id: String(item?.id || crypto.randomUUID()),
        title: String(item?.title || "Conversation").slice(0, 120),
        updated_at: String(item?.updated_at || new Date().toISOString()),
        messages: Array.isArray(item?.messages)
          ? item.messages
              .filter((message) => message?.role === "user" || message?.role === "assistant")
              .slice(-MAX_HISTORY)
              .map((message) => ({ role: message.role, content: String(message.content || "").slice(0, 12000) }))
          : [],
      }));
    } catch {
      return [];
    }
  }

  function persistConversations() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversations.slice(0, 50)));
    } catch {
      showToast("Local history storage is full");
    }
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[char]);
  }

  function icon(name) {
    const icons = {
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1"></path></svg>',
      chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>',
    };
    return icons[name] || "";
  }

  function showToast(message) {
    const toast = qs("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove("show"), 1500);
  }

  function utcNow() {
    return new Date().toISOString();
  }

  function stageForPhase(phase) {
    return Number.isInteger(PHASE_TO_STAGE[phase]) ? PHASE_TO_STAGE[phase] : null;
  }

  function cancelThinkingTransitions() {
    clearTimeout(state.thinking.transitionTimer);
    clearTimeout(state.thinking.settleTimer);
    state.thinking.transitionTimer = null;
    state.thinking.settleTimer = null;
    state.thinking.playing = false;
  }

  function requestThinkingStage(stage) {
    if (!Number.isInteger(stage)) return;
    state.thinking.desiredStage = stage;
    const phrase = qs('#thinkingPhrase');
    const thinking = qs('#thinking');
    if (!phrase || !thinking) return;
    thinking.classList.add('visible');

    const labels = state.thinking.labels || PHRASES;
    if (state.thinking.playing) return;
    if (state.thinking.stage === state.thinking.desiredStage && phrase.textContent === (labels[state.thinking.stage] || PHRASES[state.thinking.stage])) return;

    state.thinking.playing = true;
    phrase.classList.remove('is-in', 'is-resting');
    phrase.classList.add('is-out');

    state.thinking.transitionTimer = setTimeout(() => {
      const nextStage = state.thinking.desiredStage;
      state.thinking.stage = nextStage;
      const nextLabels = state.thinking.labels || PHRASES;
      phrase.textContent = nextLabels[nextStage] || PHRASES[nextStage] || PHRASES[0];
      phrase.classList.remove('is-out');
      phrase.classList.add('is-in');
      requestAnimationFrame(() => {
        phrase.classList.remove('is-in');
        phrase.classList.add('is-resting');
      });
      state.thinking.settleTimer = setTimeout(() => {
        state.thinking.playing = false;
        if (state.thinking.stage !== state.thinking.desiredStage) requestThinkingStage(state.thinking.desiredStage);
      }, 260);
    }, 160);
  }

  function beginThinking(prompt) {
    cancelThinkingTransitions();
    state.thinking.stage = 0;
    state.thinking.desiredStage = 0;
    state.thinking.labels = [...PHRASES];
    const phrase = qs('#thinkingPhrase');
    if (phrase) {
      phrase.textContent = PHRASES[0];
      phrase.className = 'thinking-phrase is-resting';
    }
    qs('#thinking')?.classList.add('visible');
    state.currentPrompt = prompt;
  }

  function hideThinking() {
    const thinking = qs('#thinking');
    if (!thinking) return;
    thinking.classList.remove('visible');
  }

  async function copyText(text) {
    const value = String(text ?? '');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // Fall back below.
    }
    return fallbackCopy(value);
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
    return copied;
  }

  function inlineMarkdown(value) {
    let out = esc(value);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return out;
  }

  function markdownToHtml(markdown) {
    const text = String(markdown || '').replace(/\r\n?/g, '\n');
    const codeBlocks = [];
    const withoutCode = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const token = `@@CODEBLOCK${codeBlocks.length}@@`;
      codeBlocks.push(`<pre><code class="language-${esc(lang || 'text')}">${esc(code.trimEnd())}</code></pre>`);
      return token;
    });

    const lines = withoutCode.split('\n');
    const html = [];
    let paragraph = [];
    let list = null;

    const closeParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (!list) return;
      html.push(`</${list}>`);
      list = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        closeParagraph();
        closeList();
        continue;
      }

      if (/^@@CODEBLOCK\d+@@$/.test(trimmed)) {
        closeParagraph();
        closeList();
        html.push(trimmed);
        continue;
      }

      // Simple GitHub-style markdown table support.
      const next = lines[i + 1]?.trim() || '';
      if (trimmed.includes('|') && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(next)) {
        closeParagraph();
        closeList();

        const splitCells = (value) => value.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        const headerCells = splitCells(trimmed);
        const alignCells = splitCells(next);
        const aligns = alignCells.map((cell) => {
          if (/^:-+:$/.test(cell)) return 'center';
          if (/^-+:$/.test(cell)) return 'right';
          return 'left';
        });

        const rows = [];
        i += 2;
        while (i < lines.length) {
          const rowLine = lines[i].trim();
          if (!rowLine || !rowLine.includes('|')) {
            i -= 1;
            break;
          }
          rows.push(splitCells(rowLine));
          i += 1;
        }

        html.push('<div class="table-wrap"><table><thead><tr>' + headerCells.map((cell, index) => `<th style="text-align:${aligns[index] || 'left'}">${inlineMarkdown(cell)}</th>`).join('') + '</tr></thead><tbody>');
        for (const row of rows) {
          html.push('<tr>' + headerCells.map((_, index) => `<td style="text-align:${aligns[index] || 'left'}">${inlineMarkdown(row[index] || '')}</td>`).join('') + '</tr>');
        }
        html.push('</tbody></table></div>');
        continue;
      }

      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        closeParagraph();
        closeList();
        const level = Math.min(3, heading[1].length);
        html.push(`<h${level + 1}>${inlineMarkdown(heading[2])}</h${level + 1}>`);
        continue;
      }

      const quote = trimmed.match(/^>\s?(.*)$/);
      if (quote) {
        closeParagraph();
        closeList();
        html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }

      const unordered = trimmed.match(/^[-*]\s+(.+)$/);
      if (unordered) {
        closeParagraph();
        if (list !== 'ul') {
          closeList();
          list = 'ul';
          html.push('<ul>');
        }
        html.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
        continue;
      }

      const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (ordered) {
        closeParagraph();
        if (list !== 'ol') {
          closeList();
          list = 'ol';
          html.push('<ol>');
        }
        html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
        continue;
      }

      closeList();
      paragraph.push(trimmed);
    }

    closeParagraph();
    closeList();

    let rendered = html.join('\n');
    rendered = rendered.replace(/@@CODEBLOCK(\d+)@@/g, (_, n) => codeBlocks[Number(n)] || '');
    return rendered || `<p>${inlineMarkdown(text)}</p>`;
  }

  function longPromptHtml(message, index) {
    const key = `${state.activeConversationId}:${index}`;
    const long = message.content.length > 220 || message.content.split(/\s+/).length > 42;
    const expanded = state.thoughtExpanded.has(key);
    return `
      <div class="thought-block">
        <div class="thought-rail" aria-hidden="true"></div>
        <div class="thought-content">
          <div class="thought-preview ${long && !expanded ? 'long-collapsed' : ''}">
            <p class="thought-text ${long ? 'long' : ''} ${long && !expanded ? 'collapsed' : ''}">${esc(message.content)}</p>
            ${long ? `<button class="thought-toggle ${expanded ? 'expanded' : ''}" data-thought-toggle="${esc(key)}" type="button" aria-label="${expanded ? 'Collapse thought' : 'Expand thought'}" title="${expanded ? 'Collapse thought' : 'Expand thought'}">${icon('chevron')}</button>` : ''}
          </div>
          ${long ? `<div class="thought-tools"><button class="thought-tool" data-copy-thought="${esc(key)}" type="button" aria-label="Copy thought" title="Copy thought"><span class="tool-icon">${icon('copy')}</span></button></div>` : ''}
        </div>
      </div>`;
  }

  function pairHtml(user, assistant, index, isLastUser) {
    let right = '';
    if (assistant) {
      right = `<div class="response-wrap"><div class="answer-rail" aria-hidden="true"></div><div class="response-content"><article class="response visible" data-response-index="${index}"><div class="response-body">${markdownToHtml(assistant.content)}</div><div class="actions"><button class="response-action" data-copy-response="${index}" type="button">Copy</button><button class="response-action" data-regenerate="${index}" type="button">Regenerate</button><button class="response-action" data-more="${index}" type="button">More</button></div></article></div></div>`;
    } else if (isLastUser && state.controller) {
      const stage = stageForPhase(state.currentPhase) ?? 0;
      const label = (state.thinking.labels || PHRASES)[stage] || PHRASES[stage];
      right = `<div class="response-wrap"><div class="answer-rail" aria-hidden="true"></div><div class="response-content"><div class="thinking visible" id="thinking"><span aria-hidden="true" class="signal"></span><span class="thinking-phrase is-resting" id="thinkingPhrase">${esc(label)}</span></div><article class="response" id="response"><div class="response-body" id="responseBody"></div><div class="actions"><button class="response-action" data-copy-response="${index}" type="button">Copy</button><button class="response-action" data-regenerate="${index}" type="button">Regenerate</button><button class="response-action" data-more="${index}" type="button">More</button></div></article></div></div>`;
    }
    return `<div class="conversation-pair" data-pair="${index}">${longPromptHtml(user, index)}${right}</div>`;
  }

  function conversationMarkup() {
    const blocks = [];
    const userIndexes = state.messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    const lastUserIndex = userIndexes[userIndexes.length - 1];
    for (const index of userIndexes) {
      const user = state.messages[index];
      const assistant = state.messages[index + 1]?.role === 'assistant' ? state.messages[index + 1] : null;
      blocks.push(pairHtml(user, assistant, index, index === lastUserIndex));
    }
    return blocks.join('');
  }

  function renderConversation(force = false) {
    const conversation = qs('#conversation');
    const empty = qs('#emptyState');
    if (!conversation || !empty) return;

    const userCount = state.messages.filter((m) => m.role === 'user').length;
    empty.style.display = userCount ? 'none' : 'flex';
    conversation.classList.toggle('active', Boolean(userCount));

    if (!userCount) {
      conversation.innerHTML = '';
      state.renderKey = '';
      updateScrollButton();
      return;
    }

    const key = state.messages.map((m) => `${m.role}:${m.content}`).join('|') + `|${state.activeConversationId}`;
    if (!force && key === state.renderKey) return;

    state.renderKey = key;
    conversation.innerHTML = conversationMarkup();
    bindConversationControls();

    if (state.controller) {
      requestAnimationFrame(() => {
        const phrase = qs('#thinkingPhrase');
        if (phrase) {
          const labels = state.thinking.labels || PHRASES;
          phrase.textContent = labels[state.thinking.stage] || PHRASES[state.thinking.stage] || PHRASES[0];
          phrase.className = 'thinking-phrase is-resting';
        }
      });
    }
    updateScrollButton();
  }

  function bindConversationControls() {
    qsa('[data-thought-toggle]').forEach((button) => {
      button.onclick = () => {
        const key = button.dataset.thoughtToggle;
        if (state.thoughtExpanded.has(key)) state.thoughtExpanded.delete(key);
        else state.thoughtExpanded.add(key);
        renderConversation(true);
      };
    });

    qsa('[data-copy-thought]').forEach((button) => {
      button.onclick = async () => {
        const parts = String(button.dataset.copyThought || '').split(':');
        const message = state.messages[Number(parts[parts.length - 1])];
        if (!message) return;
        if (await copyText(message.content)) showToast('Thought copied');
      };
    });

    qsa('[data-copy-response]').forEach((button) => {
      button.onclick = async () => {
        const index = Number(button.dataset.copyResponse);
        const message = state.messages[index + 1];
        const text = message?.content || state.responseText;
        if (!text) return;
        if (await copyText(text)) showToast('Response copied');
      };
    });

    qsa('[data-regenerate]').forEach((button) => {
      button.onclick = () => regenerate(Number(button.dataset.regenerate));
    });

    qsa('[data-more]').forEach((button) => {
      button.onclick = () => showToast('More controls coming soon');
    });
  }

  function saveConversation() {
    const firstUser = state.messages.find((m) => m.role === 'user');
    if (!firstUser) return;
    const payload = {
      id: state.activeConversationId,
      title: firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 72) || 'New conversation',
      updated_at: new Date().toISOString(),
      messages: state.messages.slice(-MAX_HISTORY),
    };
    const existing = state.conversations.find((item) => item.id === state.activeConversationId);
    if (existing) Object.assign(existing, payload);
    else state.conversations.unshift(payload);
    state.conversations = state.conversations.slice(0, 50);
    persistConversations();
  }

  function openConversation(id) {
    if (state.controller) return;
    const item = state.conversations.find((entry) => entry.id === id);
    if (!item) return;
    state.activeConversationId = item.id;
    state.messages = structuredClone(item.messages || []);
    state.thoughtExpanded.clear();
    renderConversation(true);
    closeHistory();
    requestAnimationFrame(() => scrollToLatest('instant'));
  }

  function newConversation() {
    if (state.controller) return;
    saveConversation();
    state.messages = [];
    state.activeConversationId = crypto.randomUUID();
    state.thoughtExpanded.clear();
    state.currentPhase = 'idle';
    state.responseText = '';
    state.responseHtml = '';
    state.currentSources = [];
    renderConversation(true);
    renderHistory();
    scrollToLatest('instant');
  }

  function deleteConversation(id) {
    if (state.controller) return;
    state.conversations = state.conversations.filter((entry) => entry.id !== id);
    persistConversations();
    if (id === state.activeConversationId) newConversation();
    else renderHistory();
  }

  function renderHistory() {
    const panel = qs('#historyBackdrop .history-panel');
    if (!panel) return;
    qsa('.history-section.dynamic', panel).forEach((section) => section.remove());
    const section = document.createElement('div');
    section.className = 'history-section dynamic';
    const items = state.conversations.length ? state.conversations : [
      { id: 'mock-1', title: 'Designing a better city', updated_at: '' },
      { id: 'mock-2', title: 'Product concept', updated_at: '' },
      { id: 'mock-3', title: 'Interface ideas', updated_at: '' },
    ];
    section.innerHTML = `<div class="history-section-label">Conversations</div>${items.map((item) => `<button class="entry ${item.id === state.activeConversationId ? 'selected' : ''}" data-history-id="${esc(item.id)}" type="button"><span class="entry-text">${esc(item.title)}</span><span class="entry-time">${formatTime(item.updated_at)}</span></button>`).join('')}`;
    panel.appendChild(section);

    qsa('[data-history-id]', section).forEach((button) => {
      button.onclick = () => {
        const id = button.dataset.historyId;
        if (id.startsWith('mock-')) showToast('Example history item');
        else openConversation(id);
      };
      button.oncontextmenu = (event) => {
        if (button.dataset.historyId.startsWith('mock-')) return;
        event.preventDefault();
        deleteConversation(button.dataset.historyId);
      };
    });
  }

  function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function openHistory() {
    renderHistory();
    const backdrop = qs('#historyBackdrop');
    backdrop?.classList.add('open');
    backdrop?.setAttribute('aria-hidden', 'false');
  }

  function closeHistory() {
    const backdrop = qs('#historyBackdrop');
    backdrop?.classList.remove('open');
    backdrop?.setAttribute('aria-hidden', 'true');
  }

  function scrollSurface() { return root; }

  function scrollToLatest(behavior = 'smooth') {
    const surface = scrollSurface();
    surface.scrollTo({ top: surface.scrollHeight, behavior });
  }

  function updateScrollButton() {
    const button = qs('#scrollLatest');
    if (!button) return;
    const surface = scrollSurface();
    const distance = surface.scrollHeight - surface.scrollTop - surface.clientHeight;
    button.classList.toggle('visible', distance > 180);
  }

  function updateFollowState() {
    const surface = scrollSurface();
    const distance = surface.scrollHeight - surface.scrollTop - surface.clientHeight;
    state.followLatest = distance < 230;
    updateScrollButton();
  }

  function updateComposerHeight() {
    const wrap = qs('.composer-wrap');
    if (!wrap) return;
    const height = Math.ceil(wrap.getBoundingClientRect().height);
    root.style.setProperty('--composer-stack-height', `${height}px`);
    root.style.setProperty('--composer-clearance', `${height + 112}px`);
  }

  function resizeInput() {
    const textarea = qs('#input');
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
    requestAnimationFrame(updateComposerHeight);
  }

  function setBusy(busy) {
    qsa('.mode').forEach((button) => {
      button.disabled = busy;
      button.classList.toggle('disabled', busy);
    });
    const send = qs('#sendBtn');
    const textarea = qs('#input');
    if (send) {
      send.disabled = busy || !textarea?.value.trim();
      send.classList.toggle('disabled', send.disabled);
    }
  }

  function updateSendState() {
    const textarea = qs('#input');
    const send = qs('#sendBtn');
    if (!textarea || !send) return;
    send.disabled = Boolean(state.controller) || !textarea.value.trim();
    send.classList.toggle('disabled', send.disabled);
  }

  function trimModelHistory(messages) {
    const filtered = messages
      .filter((message) => message?.role === 'user' || message?.role === 'assistant')
      .slice(-MAX_HISTORY)
      .map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(-12000),
      }));

    let total = 0;
    const result = [];
    for (let i = filtered.length - 1; i >= 0; i -= 1) {
      const size = filtered[i].content.length;
      if (result.length && total + size > MAX_MODEL_HISTORY_CHARS) break;
      result.unshift(filtered[i]);
      total += size;
    }
    return result;
  }

  function updateLiveResponse(text) {
    state.responseText = text;
    const body = qs('#liveResponseBody') || qs('#responseBody');
    if (!body) return;
    body.innerHTML = markdownToHtml(text);
    const article = body.closest('.response');
    article?.classList.add('visible');
  }

  async function streamMoina(messages, mode, signal, onEvent) {
    const response = await fetch(`${API_BASE_URL}/api/v1/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, mode }),
      signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(String(payload?.error || "Moina could not complete that request."));
      error.status = response.status;
      throw error;
    }
    if (!response.body) throw new Error("Moina returned no response stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const flush = (frame) => {
      const lines = frame.replace(/\r/g, "").split("\n");
      let event = "message";
      const data = [];
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) return;
      try {
        const parsed = JSON.parse(data.join("\n"));
        onEvent(event, parsed);
      } catch {
        // Ignore malformed keep-alives.
      }
    };

    try {
      while (true) {
        if (signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = -1;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          flush(frame);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) flush(buffer);
    } finally {
      try { await reader.cancel(); } catch {}
    }
  }

  function sanitizePromptLocal(prompt) {
    return String(prompt || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .trim();
  }

  async function runChat(prompt, operation = "submit", userIndex = null) {
    if (state.controller) return;
    let cleanPrompt;
    try {
      cleanPrompt = sanitizePromptLocal(prompt);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Prompt blocked by security guardrail");
      return;
    }
    if (!cleanPrompt || cleanPrompt.length > MAX_PROMPT_CHARS) {
      showToast(cleanPrompt.length > MAX_PROMPT_CHARS ? `Prompt limit: ${MAX_PROMPT_CHARS} characters` : "Enter a thought");
      return;
    }

    if (operation === "submit") {
      state.messages.push({ role: "user", content: cleanPrompt });
      userIndex = state.messages.length - 1;
    } else if (operation !== "regenerate" || typeof userIndex !== "number" || state.messages[userIndex]?.role !== "user") {
      return;
    }

    const previousTail = operation === "regenerate" ? state.messages.slice(userIndex + 1) : [];
    if (operation === "regenerate") state.messages = state.messages.slice(0, userIndex + 1);

    state.currentPhase = "initializing";
    state.currentPrompt = cleanPrompt;
    state.responseText = "";
    state.responseHtml = "";
    state.currentSources = [];
    state.controller = new AbortController();
    beginThinking(cleanPrompt);
    renderConversation(true);
    setBusy(true);
    requestAnimationFrame(() => {
      scrollToLatest("smooth");
      resizeInput();
    });

    const mode = state.mode;
    const requestMessages = state.messages.slice(-MAX_HISTORY);
    let streamedText = "";

    try {
      await streamMoina(
        requestMessages,
        mode,
        state.controller.signal,
        (event, payload) => {
          if (event === "phase") {
            state.currentPhase = String(payload?.phase || "synthesizing");
            const stage = PHASE_TO_STAGE[state.currentPhase];
            if (Number.isInteger(stage)) requestThinkingStage(stage);
          } else if (event === "sources") {
            state.currentSources = Array.isArray(payload?.sources) ? payload.sources : [];
          } else if (event === "delta") {
            const chunk = String(payload?.text || "");
            if (!chunk) return;
            streamedText += chunk;
            state.responseText = streamedText;
            hideThinking();
            updateLiveResponse(streamedText);
            if (state.followLatest) scrollToLatest("auto");
          } else if (event === "notice") {
            showToast(String(payload?.message || "Moina continued."));
          } else if (event === "error") {
            throw new Error(String(payload?.message || "Moina could not complete that request."));
          }
        },
      );

      if (!streamedText.trim()) throw new Error("Moina could not produce a response this time. Please try again.");
      state.messages[userIndex + 1] = { role: "assistant", content: streamedText.trim() };
      saveConversation();
      state.renderKey = "";
    } catch (error) {
      if (error?.name !== "AbortError") {
        showToast(error instanceof Error ? error.message : "Moina could not complete that request.");
      }
      if (operation === "submit") state.messages = state.messages.slice(0, userIndex);
      else state.messages = state.messages.slice(0, userIndex + 1).concat(previousTail);
    } finally {
      hideThinking();
      cancelThinkingTransitions();
      state.controller = null;
      state.currentPhase = "idle";
      setBusy(false);
      renderConversation(true);
      renderHistory();
      requestAnimationFrame(() => {
        scrollToLatest("smooth");
        updateComposerHeight();
      });
      updateSendState();
    }
  }

  function regenerate(index) {
    const prompt = state.messages[index]?.content;
    if (prompt) runChat(prompt, "regenerate", index);
  }

  // Header + settings
  qs("#historyBtn")?.addEventListener("click", openHistory);
  qs("#closeHistory")?.addEventListener("click", closeHistory);
  qs("#historyBackdrop")?.addEventListener("click", (event) => {
    if (event.target === qs("#historyBackdrop")) closeHistory();
  });
  qs("#newBtn")?.addEventListener("click", newConversation);
  qs("#settingsBtn")?.addEventListener("click", () => showToast("Moina Intelligence · Multi-model reasoning + research + verification"));

  // Modes
  qsa(".mode").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.controller) return;
      state.mode = button.dataset.mode || "auto";
      localStorage.setItem(MODE_KEY, state.mode);
      qsa(".mode").forEach((item) => {
        const active = item.dataset.mode === state.mode;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
      showToast(`${MODE_LABELS[state.mode]} mode`);
    });
  });

  // Composer
  const input = qs("#input");
  input?.addEventListener("input", () => {
    resizeInput();
    updateSendState();
  });
  input?.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const prompt = input.value;
      input.value = "";
      resizeInput();
      updateSendState();
      runChat(prompt);
    }
  });
  qs("#sendBtn")?.addEventListener("click", async () => {
    if (!input?.value.trim()) return;
    const prompt = input.value;
    input.value = "";
    resizeInput();
    updateSendState();
    runChat(prompt);
  });
  qs("#attachBtn")?.addEventListener("click", () => showToast("Attachments are reserved for a later release"));

  // Suggestions
  qsa("[data-suggestion]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!input) return;
      input.value = button.dataset.suggestion || "";
      resizeInput();
      input.focus();
      updateSendState();
    });
  });

  // Navigation
  scrollSurface().addEventListener("scroll", updateFollowState, { passive: true });
  qs("#scrollLatest")?.addEventListener("click", () => scrollToLatest("smooth"));
  window.addEventListener("resize", () => {
    resizeInput();
    updateComposerHeight();
    updateScrollButton();
  });

  qsa(".mode").forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  renderConversation(true);
  renderHistory();
  requestAnimationFrame(() => {
    resizeInput();
    updateComposerHeight();
    updateScrollButton();
  });
})();
