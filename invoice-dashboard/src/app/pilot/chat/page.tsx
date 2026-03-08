"use client";

import { useState, useRef, useEffect } from "react";

type BotTab = "citation-x" | "challenger-300";

const BOTS: Record<BotTab, { label: string; description: string; placeholder: string }> = {
  "citation-x": {
    label: "Citation X (CE-750)",
    description: "Ask about systems, procedures, checklists, and technical references for the Citation X.",
    placeholder: "e.g. What are the hydraulic system limitations?",
  },
  "challenger-300": {
    label: "Challenger 300",
    description: "Ask about systems, procedures, checklists, and technical references for the Challenger 300.",
    placeholder: "e.g. What is the engine start sequence?",
  },
};

export default function PilotChatPage() {
  const [activeBot, setActiveBot] = useState<BotTab>("citation-x");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string; sources?: { title: string; category: string }[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const bot = BOTS[activeBot];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSwitchBot(tab: BotTab) {
    setActiveBot(tab);
    setMessages([]);
    setInput("");
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const res = await fetch("/api/pilot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg, context: activeBot }),
      });

      if (!res.ok) throw new Error("Failed to get response");

      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply, sources: data.sources }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, something went wrong. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] sm:h-[calc(100vh-7rem)]">
      <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mb-1">Aircraft Chat</h1>
      <p className="text-gray-500 text-sm mb-4 sm:mb-6">
        Select a topic area and ask your question below.
      </p>

      {/* Bot selector tabs */}
      <div className="flex gap-1 mb-4 sm:mb-6 border-b border-gray-200 overflow-x-auto">
        {(Object.entries(BOTS) as [BotTab, typeof bot][]).map(([key, b]) => (
          <button
            key={key}
            onClick={() => handleSwitchBot(key)}
            className={`px-3 sm:px-4 py-2 text-sm font-medium rounded-t-md transition-colors whitespace-nowrap ${
              activeBot === key
                ? "text-blue-900 border-b-2 border-blue-900"
                : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <p className="text-sm text-gray-500 mb-3 sm:mb-4">{bot.description}</p>

      {/* Chat messages */}
      <div className="flex-1 bg-white border border-gray-200 rounded-lg overflow-y-auto p-3 sm:p-4 mb-3 sm:mb-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <p className="text-gray-400 text-sm text-center mt-12">
            No messages yet. Ask a question to get started.
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`max-w-[90%] sm:max-w-[80%] ${msg.role === "user" ? "self-end" : "self-start"}`}>
            <div
              className={`rounded-lg px-3 sm:px-4 py-2 text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-900 text-white"
                  : "bg-gray-100 text-gray-800"
              }`}
            >
              {msg.content}
            </div>
            {msg.sources && msg.sources.length > 0 && (
              <p className="text-xs text-gray-400 mt-1 px-1">
                Sources: {msg.sources.map((s) => s.title).join(", ")}
              </p>
            )}
          </div>
        ))}
        {loading && (
          <div className="self-start bg-gray-100 text-gray-400 rounded-lg px-3 sm:px-4 py-2 text-sm">
            Thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={bot.placeholder}
          disabled={loading}
          className="flex-1 border border-gray-300 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-blue-900 text-white rounded-md px-4 sm:px-5 py-2.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
        >
          Send
        </button>
      </form>
    </div>
  );
}
