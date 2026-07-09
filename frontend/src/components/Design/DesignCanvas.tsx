import { useEffect, useRef, useCallback } from "react";
import grapesjs from "grapesjs";
import "grapesjs/dist/css/grapes.min.css";

interface DesignCanvasProps {
  html?: string;
  css?: string;
  onChange?: (html: string, css: string) => void;
  onReady?: (editor: any) => void;
  className?: string;
}

export function DesignCanvas({
  html,
  css,
  onChange,
  onReady,
  className = "",
}: DesignCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const initializedRef = useRef(false);
  const callbacksRef = useRef({ onChange, onReady });
  callbacksRef.current = { onChange, onReady };

  useEffect(() => {
    // Prevent double-init in React 18 StrictMode
    if (initializedRef.current) return;
    if (!containerRef.current) return;

    initializedRef.current = true;

    const editor = grapesjs.init({
      container: containerRef.current,
      height: "100%",
      width: "100%",
      storageManager: false,
      fromElement: false,
      avoidInlineStyle: true,
      ...(html
        ? { components: html }
        : {
            components:
              '<div style="padding: 50px; text-align: center;"><h1>Nouveau design</h1><p>Commencez à éditer...</p></div>',
          }),
      ...(css ? { style: css } : {}),
      canvas: {
        styles: [
          "https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css",
        ],
      },
    });

    editorRef.current = editor;

    // Notify parent when editor is ready
    if (callbacksRef.current.onReady) {
      callbacksRef.current.onReady(editor);
    }

    // Listen for changes
    const emitChange = () => {
      if (callbacksRef.current.onChange) {
        const html = editor.getHtml() ?? "";
        const css = editor.getCss() ?? "";
        callbacksRef.current.onChange(html, css);
      }
    };

    editor.on("component:update", emitChange);
    editor.on("component:add", emitChange);
    editor.on("component:remove", emitChange);

    return () => {
      editor.destroy();
      editorRef.current = null;
      initializedRef.current = false;
    };
  }, []); // Intent: init once; html/css updates are handled via editor API calls

  const getHtml = useCallback((): string => {
    return editorRef.current?.getHtml() ?? "";
  }, []);

  const getCss = useCallback((): string => {
    return editorRef.current?.getCss() ?? "";
  }, []);

  // Expose editor methods via ref on the component instance
  (DesignCanvas as any)._getEditor = () => editorRef.current;

  return (
    <div
      ref={containerRef}
      className={`w-full h-full ${className}`}
      style={{ minHeight: 0 }}
    />
  );
}
