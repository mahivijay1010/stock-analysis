'use client';

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { MessageSquare, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import { askAssistant, ApiError } from '@/lib/api';

interface ChatMsg {
  id: number;
  role: 'user' | 'bot';
  text: string;
  at: number; // epoch ms
  suggestions?: string[];
  error?: boolean;
  /** original user text to re-send from an error bubble */
  retryText?: string;
}

const STARTER_CHIPS = [
  'Top 5 stocks today',
  'Should I buy TCS today or wait?',
  'Split ₹10,000 long term',
  'How accurate are you?',
];

const WELCOME: ChatMsg = {
  id: 0,
  role: 'bot',
  text: 'Namaste! I am Sensei — I answer NSE stock questions only: picks, verdicts, allocations and this model’s measured accuracy.',
  at: 0, // set on first open (client-side) to avoid a hydration mismatch
  suggestions: STARTER_CHIPS,
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div className="glass-inset flex items-center gap-1 px-3.5 py-3">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="sr-only">Sensei is typing…</span>
      </div>
    </div>
  );
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([WELCOME]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const idRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Stamp the welcome message the first time the panel opens.
  useEffect(() => {
    if (open) {
      setMessages((ms) => (ms[0]?.id === 0 && ms[0].at === 0 ? [{ ...ms[0], at: Date.now() }, ...ms.slice(1)] : ms));
      inputRef.current?.focus();
    }
  }, [open]);

  // Auto-scroll to the newest message / typing indicator.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, open]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;
      const userMsg: ChatMsg = { id: idRef.current++, role: 'user', text: trimmed, at: Date.now() };
      setMessages((ms) => [...ms, userMsg]);
      setDraft('');
      setPending(true);
      try {
        const res = await askAssistant(trimmed);
        setMessages((ms) => [
          ...ms,
          {
            id: idRef.current++,
            role: 'bot',
            text: res.reply,
            at: Date.now(),
            suggestions: res.suggestions?.length ? res.suggestions : undefined,
          },
        ]);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Sensei could not answer right now.';
        setMessages((ms) => [
          ...ms,
          { id: idRef.current++, role: 'bot', text: msg, at: Date.now(), error: true, retryText: trimmed },
        ]);
      } finally {
        setPending(false);
        inputRef.current?.focus();
      }
    },
    [pending],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  const lastBotId = [...messages].reverse().find((m) => m.role === 'bot' && !m.error)?.id;

  return (
    <>
      {/* Overlay — click closes; FAB stays visible above it */}
      <AnimatePresence>
        {open && (
          <motion.button
            type="button"
            aria-label="Close Sensei"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-black/30"
          />
        )}
      </AnimatePresence>

      {/* Chat panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Sensei — stocks only"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed inset-x-3 bottom-24 z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0a0e1b]/90 shadow-2xl shadow-black/60 backdrop-blur-xl sm:inset-x-auto sm:right-5 sm:w-[400px] sm:min-w-[380px]"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 to-violet-500">
                  <Sparkles className="h-4 w-4 text-white" aria-hidden />
                </span>
                <div className="leading-tight">
                  <p className="font-display text-sm font-semibold tracking-wide text-slate-100">Sensei</p>
                  <p className="text-[11px] text-slate-400">stocks only — not investment advice</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close chat"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/8 hover:text-slate-100"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {/* Messages */}
            <div ref={listRef} className="thin-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.map((m) => (
                <div key={m.id}>
                  <div className={clsx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div
                      className={clsx(
                        'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-line',
                        m.role === 'user'
                          ? 'rounded-br-md border border-cyan-400/25 bg-cyan-400/12 text-slate-100'
                          : m.error
                            ? 'rounded-bl-md border border-rose-500/30 bg-rose-500/10 text-rose-200'
                            : 'glass-inset rounded-bl-md text-slate-200',
                      )}
                    >
                      {m.text}
                      {m.error && m.retryText && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => void send(m.retryText as string)}
                          className="mt-2 flex items-center gap-1.5 rounded-lg border border-rose-400/40 px-2.5 py-1 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/15 disabled:opacity-50"
                        >
                          <RefreshCw className="h-3 w-3" aria-hidden />
                          Retry
                        </button>
                      )}
                      {m.at > 0 && (
                        <p className={clsx('mt-1 text-[10px]', m.role === 'user' ? 'text-cyan-200/50' : 'text-slate-500')}>
                          {fmtTime(m.at)}
                        </p>
                      )}
                    </div>
                  </div>
                  {/* Suggestion chips under the latest bot message */}
                  {m.role === 'bot' && !m.error && m.id === lastBotId && m.suggestions && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.suggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          disabled={pending}
                          onClick={() => void send(s)}
                          className="rounded-full border border-violet-400/30 bg-violet-400/10 px-3 py-1 text-xs text-violet-300 transition-colors hover:bg-violet-400/20 hover:text-violet-200 disabled:opacity-50"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {pending && <TypingBubble />}
            </div>

            {/* Input row */}
            <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-white/8 px-3 py-3">
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                disabled={pending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Ask about any NSE stock…"
                aria-label="Message Sensei"
                className="input-glass max-h-28 min-h-[42px] flex-1 resize-none px-3.5 py-2.5 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={pending || !draft.trim()}
                aria-label="Send message"
                className="btn-primary h-[42px] w-[42px] shrink-0 rounded-xl"
              >
                <Send className="h-4 w-4" aria-hidden />
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating action button — always visible */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close Sensei chat' : 'Open Sensei — the stocks-only assistant'}
        className={clsx(
          'fab-glow fixed right-5 bottom-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-violet-500 text-white transition-transform duration-200 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400',
        )}
      >
        {open ? <X className="h-6 w-6" aria-hidden /> : <MessageSquare className="h-6 w-6" aria-hidden />}
      </button>
    </>
  );
}
