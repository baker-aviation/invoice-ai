"use client";

import { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";

function ToolbarBtn({
  label,
  command,
  value,
}: {
  label: string;
  command: string;
  value?: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        document.execCommand(command, false, value);
      }}
      className="px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200 rounded transition-colors"
      title={label}
    >
      {label}
    </button>
  );
}

export type RichTextEditorHandle = {
  getHTML: () => string;
};

type RichTextEditorProps = {
  initialHTML?: string;
  placeholder?: string;
  expanded?: boolean;
};

const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  function RichTextEditor({ initialHTML, placeholder = "Write something...", expanded }, ref) {
    const editorRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (editorRef.current && initialHTML) {
        editorRef.current.innerHTML = initialHTML;
      }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const getHTML = useCallback(() => {
      return editorRef.current?.innerHTML?.trim() || "";
    }, []);

    useImperativeHandle(ref, () => ({ getHTML }), [getHTML]);

    return (
      <div className="border border-gray-200 rounded-lg flex flex-col flex-1 min-h-0 overflow-hidden focus-within:border-gray-400">
        {/* Toolbar */}
        <div className="flex items-center gap-0.5 px-2 py-1 border-b border-gray-100 bg-gray-50 shrink-0 flex-wrap">
          <ToolbarBtn label="B" command="bold" />
          <ToolbarBtn label="I" command="italic" />
          <ToolbarBtn label="U" command="underline" />
          <span className="w-px h-4 bg-gray-200 mx-1" />
          <ToolbarBtn label="H1" command="formatBlock" value="h1" />
          <ToolbarBtn label="H2" command="formatBlock" value="h2" />
          <ToolbarBtn label="H3" command="formatBlock" value="h3" />
          <span className="w-px h-4 bg-gray-200 mx-1" />
          <ToolbarBtn label="List" command="insertUnorderedList" />
          <ToolbarBtn label="1." command="insertOrderedList" />
        </div>
        {/* Editable area */}
        <div
          ref={editorRef}
          contentEditable
          className={`px-3 py-2 text-sm outline-none overflow-y-auto prose prose-sm max-w-none ${
            expanded ? "flex-1" : "min-h-[200px] max-h-[400px]"
          }`}
          data-placeholder={placeholder}
          suppressContentEditableWarning
        />
      </div>
    );
  },
);

export default RichTextEditor;
