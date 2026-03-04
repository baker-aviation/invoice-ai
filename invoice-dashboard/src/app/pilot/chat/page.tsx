"use client";

import { useState } from "react";

type BotTab = "systems" | "procedures";

const BOTS: Record<BotTab, { label: string; description: string; placeholder: string }> = {
  systems: {
    label: "Aircraft Systems",
    description: "Ask about aircraft systems, MEL items, and technical references.",
    placeholder: "e.g. What are the hydraulic system limitations on the CJ3?",
  },
  procedures: {
    label: "Procedures & Checklists",
    description: "Ask about SOPs, emergency procedures, and checklist items.",
    placeholder: "e.g. What is the engine start sequence for the CJ4?",
  },
};

export default function PilotChatPage() {
  const [activeBot, setActiveBot] = useState<BotTab>("systems");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const bot = BOTS[activeBot];

  function handleSwitchBot(tab: BotTab) {
    setActiveBot(tab);
    setMessages([]);
    setInput("");
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);

    // TODO: Wire up to AI backend
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: "Chat integration coming soon. This is a placeholder response.",
      },
    ]);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Aircraft Chat</h1>
      <p className="text-gray-500 text-sm mb-6">
        Select a topic area and ask your question below.
      </p>

      {/* Bot selector tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {(Object.entries(BOTS) as [BotTab, typeof bot][]).map(([key, b]) => (
          <button
            key={key}
            onClick={() => handleSwitchBot(key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
              activeBot === key
                ? "text-blue-900 border-b-2 border-blue-900"
                : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <p className="text-sm text-gray-500 mb-4">{bot.description}</p>

      {/* Chat messages */}
      <div className="bg-white border border-gray-200 rounded-lg min-h-[300px] max-h-[500px] overflow-y-auto p-4 mb-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <p className="text-gray-400 text-sm text-center mt-12">
            No messages yet. Ask a question to get started.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
              msg.role === "user"
                ? "self-end bg-blue-900 text-white"
                : "self-start bg-gray-100 text-gray-800"
            }`}
          >
            {msg.content}
          </div>
        ))}
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={bot.placeholder}
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="bg-blue-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-blue-700"
        >
          Send
        </button>
      </form>
    </div>
  );
}
