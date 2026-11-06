import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, ExternalLink, Terminal } from 'lucide-react';
import { BACKEND_HTTP as STORE_BACKEND_HTTP, API_KEY } from '../store';

/** The connected server ('' before one is assigned). */
export const getBackendHttp = (): string => STORE_BACKEND_HTTP.replace(/\/+$/, '');

/**
 * Link and image URLs from agent/model text: anything but script URLs (javascript:, vbscript:) and
 * data: other than plain images. File paths (C:/…, /Users/…, file://) stay: they become local media.
 */
export const safeMarkdownUrl = (value: string): string => {
  const v = String(value || '').replace(/[\u0000-\u001f\u007f\s]+/g, '');
  return /^(javascript|vbscript|data(?!:image\/(png|jpe?g|gif|webp)[;,]))\s*:/i.test(v) ? '' : value;
};

export const toLocalProxyUrl = (filePath: string): string => {
  let cleanLocal = (filePath || '').trim().replace(/^[`'"<]+|[`'">]+$/g, '');
  const isLocal = /^file:\/+/i.test(cleanLocal) || /^[a-zA-Z]:[\\/]/.test(cleanLocal) || cleanLocal.startsWith('/') || cleanLocal.startsWith('~');
  if (!isLocal) return cleanLocal;

  if (/^file:\/\//i.test(cleanLocal)) {
    cleanLocal = /^file:\/\/\/[a-zA-Z]:/i.test(cleanLocal)
      ? cleanLocal.replace(/^file:\/\/\//i, '')
      : cleanLocal.replace(/^file:\/\/(localhost)?/i, '');
  } else if (/^file:\/+/i.test(cleanLocal)) {
    cleanLocal = cleanLocal.replace(/^file:\/+/i, '');
    if (!/^[a-zA-Z]:/.test(cleanLocal) && !cleanLocal.startsWith('/')) {
      cleanLocal = '/' + cleanLocal;
    }
  }

  if (/^[\/\\][a-zA-Z]:/.test(cleanLocal)) {
    cleanLocal = cleanLocal.slice(1);
  }
  cleanLocal = cleanLocal.replace(/\\/g, '/');

  const rawPath = /^[a-zA-Z]:/.test(cleanLocal)
    ? `file:///${cleanLocal}`
    : (cleanLocal.startsWith('/') ? `file://${cleanLocal}` : `file:///${cleanLocal}`);

  const backend = getBackendHttp();
  const filename = cleanLocal.split('/').pop() || 'file';
  return `${backend}/api/local-image/${encodeURIComponent(filename)}?path=${encodeURIComponent(rawPath)}&api_key=${API_KEY}`;
};

interface FormattedMarkdownProps {
  content: string;
  className?: string;
  compact?: boolean;
}

const CodeBlock: React.FC<{ language?: string; value: string }> = ({ language, value }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded overflow-hidden border border-accent-cyan/20 bg-black/60 shadow-[0_0_15px_rgba(34,211,238,0.05)]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-accent-cyan/10 border-b border-accent-cyan/20 text-[9px] font-mono tracking-wider">
        <div className="flex items-center gap-1.5 text-accent-cyan">
          <Terminal size={12} className="opacity-80" />
          <span className="uppercase font-semibold">{language || 'CODE'}</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[8px] tracking-widest text-primary/60 hover:text-accent-cyan transition-colors px-1.5 py-0.5 rounded border border-transparent hover:border-accent-cyan/30"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check size={10} className="text-green-400" />
              <span className="text-green-400 font-bold">COPIED</span>
            </>
          ) : (
            <>
              <Copy size={10} />
              <span>COPY</span>
            </>
          )}
        </button>
      </div>
      <div className="p-3 overflow-x-auto text-[11px] font-mono leading-relaxed text-primary/90 selection:bg-accent-cyan/30">
        <pre className="whitespace-pre">
          <code>{value}</code>
        </pre>
      </div>
    </div>
  );
};

import { Canvas, useLoader } from '@react-three/fiber';
import { OrbitControls, useGLTF, Center, Environment, useAnimations } from '@react-three/drei';
import { OBJLoader } from 'three-stdlib';

const ObjModel: React.FC<{ url: string }> = ({ url }) => {
  const obj = useLoader(OBJLoader as any, url);
  return <primitive object={obj} />;
};

const GltfModel: React.FC<{ url: string }> = ({ url }) => {
  const { scene, animations } = useGLTF(url);
  const { ref, actions } = useAnimations(animations);
  
  React.useEffect(() => {
    // Play all animations available in the glTF file
    if (actions) {
      Object.keys(actions).forEach(key => {
        actions[key]?.reset().play();
      });
    }
  }, [actions]);

  return <primitive ref={ref} object={scene} />;
};

const ModelRenderer: React.FC<{ url: string; ext: string }> = ({ url, ext }) => {
  if (ext === 'obj') {
    return <ObjModel url={url} />;
  }
  return <GltfModel url={url} />;
};

const MEDIA_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'pdf', 'txt', 'log', 'md', 'json', 'csv', 'glb', 'gltf', 'obj', 'fbx', 'stl', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

export const MediaRenderer: React.FC<{ src: string; alt?: string }> = ({ src, alt = '' }) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  const cleanSrc = (src || '').trim().replace(/^[`'"<]+|[`'">]+$/g, '');
  const finalSrc = toLocalProxyUrl(cleanSrc);

  let purePath = cleanSrc;
  if (purePath.includes('/api/local-image')) {
    const match = purePath.match(/[?&]path=([^&]+)/);
    if (match) {
      try { purePath = decodeURIComponent(match[1]); } catch (e) {}
    }
  }
  const pureUrl = purePath.split('?')[0].split('#')[0].replace(/\\/g, '/');
  const ext = pureUrl.split('.').pop()?.toLowerCase() || '';
  const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext);
  const isAudio = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext);
  const isPdf = ['pdf'].includes(ext);
  const isTxt = ['txt', 'log', 'md', 'json', 'csv'].includes(ext);
  const is3D = ['glb', 'gltf', 'obj', 'fbx', 'stl'].includes(ext);
  const displayName = alt || pureUrl.split('/').pop() || 'file';

class ModelErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: any) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error: any) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center w-full h-full text-red-400 text-xs text-center p-4">
          <span className="font-bold mb-1">Failed to load 3D Model</span>
          <span className="opacity-70 text-[9px] break-all">{String(this.state.error?.message || 'Network Error (404)')}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

  const renderContent = (fullscreen = false) => {
    if (is3D) {
      return (
        <div 
          className={fullscreen ? "w-[90vw] h-[90vh] bg-black/80 rounded overflow-hidden" : "w-full h-[450px] bg-black/60 rounded border border-accent-cyan/30 flex items-center justify-center cursor-pointer shadow-[0_0_15px_rgba(34,211,238,0.1)] relative overflow-hidden"}
          onClick={() => !fullscreen && setIsFullscreen(true)}
        >
          {!fullscreen && (
            <div className="absolute top-2 left-2 bg-black/60 px-2 py-1 rounded text-accent-cyan text-[9px] font-bold tracking-widest z-10 border border-accent-cyan/20">
              3D MODEL ({ext.toUpperCase()})
            </div>
          )}
          <ModelErrorBoundary>
            <React.Suspense fallback={<div className="text-accent-cyan/70 text-[10px] animate-pulse">LOADING 3D DATA...</div>}>
              <Canvas camera={{ position: [0, 2, 8], fov: 45 }} style={{ width: '100%', height: '100%' }}>
                <ambientLight intensity={0.5} />
                <directionalLight position={[10, 10, 10]} intensity={1.5} />
                <Environment preset="city" />
                <OrbitControls makeDefault autoRotate={!fullscreen} />
                <Center>
                  <ModelRenderer url={finalSrc} ext={ext} />
                </Center>
              </Canvas>
            </React.Suspense>
          </ModelErrorBoundary>
        </div>
      );
    }
    if (isVideo) {
      return (
        <video 
          src={finalSrc} 
          controls 
          className={fullscreen ? "max-w-full max-h-[90vh] rounded" : "w-full max-h-[500px] object-cover rounded border border-accent-cyan/20 bg-black/40 shadow-sm"} 
        />
      );
    }
    if (isAudio) {
      return <audio src={finalSrc} controls className="w-full my-3 outline-none" />;
    }
    if (isPdf || isTxt) {
      return (
        <div 
          className={fullscreen ? "w-[90vw] h-[90vh] bg-[#f0f0f0] rounded overflow-hidden" : "w-full h-32 bg-accent-cyan/5 rounded cursor-pointer flex flex-col items-center justify-center border border-accent-cyan/20 hover:bg-accent-cyan/10 transition-colors shadow-sm"} 
          onClick={() => !fullscreen && setIsFullscreen(true)}
        >
          {fullscreen ? (
            // Text files (any site's, from an agent's answer) can't run scripts or move the app page;
            // PDFs keep the browser's viewer, which a sandbox blocks.
            <iframe src={finalSrc} className="w-full h-full border-none bg-white" title={displayName} {...(isTxt ? { sandbox: 'allow-popups allow-popups-to-escape-sandbox' } : {})} />
          ) : (
            <>
              <ExternalLink size={24} className="mb-2 text-accent-cyan opacity-80" />
              <span className="text-accent-cyan/80 font-bold tracking-widest text-[10px] uppercase">View {ext} File</span>
              <span className="text-primary/50 text-[9px] mt-1 truncate px-4 max-w-full">{displayName}</span>
            </>
          )}
        </div>
      );
    }
    
    // Image
    return (
      <img 
        src={finalSrc} 
        alt={displayName} 
        className={fullscreen ? "max-w-full max-h-[90vh] object-contain rounded" : "my-3 max-w-full rounded border border-accent-cyan/20 bg-black/40 shadow-sm cursor-pointer hover:opacity-90 transition-opacity"} 
        onClick={() => !fullscreen && setIsFullscreen(true)} 
      />
    );
  };

  return (
    <div className="my-3">
      {!isFullscreen && renderContent(false)}
      {isFullscreen && !isAudio && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-sm cursor-pointer p-8"
          onClick={() => setIsFullscreen(false)}
        >
          <div className="absolute top-6 right-8 text-accent-cyan/60 cursor-pointer hover:text-accent-cyan flex items-center gap-2 text-[10px] tracking-widest font-bold uppercase transition-colors" onClick={() => setIsFullscreen(false)}>
            Close
          </div>
          <div className="w-full h-full p-8 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            {renderContent(true)}
          </div>
        </div>
      )}
    </div>
  );
};

export const FormattedMarkdown: React.FC<FormattedMarkdownProps> = ({
  content,
  className = '',
  compact = false,
}) => {
  let topMedia = '';

  // 1. Pre-process local file links to ensure they bypass Markdown URL sanitization
  const processedContent = content.replace(/(?:!\[|\[)([^\]]*)\]\(([^)]+)\)/g, (match, alt, filePath) => {
    const isImage = match.startsWith('![');
    let candidate = filePath.trim().replace(/^<|>$/g, '');
    const isLocal = /^file:\/+/i.test(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('/') || candidate.startsWith('~');
    
    if (isLocal) {
      let testPath = candidate;
      if (testPath.includes('/api/local-image')) {
        const m = testPath.match(/[?&]path=([^&]+)/);
        if (m) { try { testPath = decodeURIComponent(m[1]); } catch(e) {} }
      }
      const ext = testPath.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() || '';
      const isMedia = MEDIA_EXTS.includes(ext);
      
      if (isMedia && !topMedia && !compact) {
        topMedia = candidate;
        return ''; // Remove from body to display at the top
      }

      const proxyUrl = toLocalProxyUrl(candidate);
      return `${isImage ? '!' : ''}[${alt}](${proxyUrl})`;
    }
    return match;
  });

  // 2. Fallback: extract bare URLs or paths if no markdown links were found
  if (!topMedia && !compact) {
    const bareRegex = /(?:(?:https?|file):\/\/[^\s"'<>`]+|(?:[a-zA-Z]:[\\/][^\s"'<>`]+)|(?:[~]?[\\/][a-zA-Z0-9_.-]+(?:[\\/][a-zA-Z0-9_.-]+)+))/gi;
    let match;
    while ((match = bareRegex.exec(content)) !== null) {
      let candidate = match[0].trim().replace(/[.,;:()\]}'"`*_]+$/, '');
      let testPath = candidate;
      if (testPath.includes('/api/local-image')) {
        const m = testPath.match(/[?&]path=([^&]+)/);
        if (m) { try { testPath = decodeURIComponent(m[1]); } catch(e) {} }
      }
      const cleanUrl = testPath.split('?')[0].split('#')[0].replace(/\\/g, '/');
      const ext = cleanUrl.split('.').pop()?.toLowerCase() || '';
      if (MEDIA_EXTS.includes(ext)) {
        topMedia = candidate;
        break;
      }
    }
  }

  // 3. Fallback: extract backtick paths
  if (!topMedia && !compact) {
    const codeMatches = content.matchAll(/`([^`]+)`/g);
    for (const match of codeMatches) {
      let candidate = match[1].trim();
      let testPath = candidate;
      if (testPath.includes('/api/local-image')) {
        const m = testPath.match(/[?&]path=([^&]+)/);
        if (m) { try { testPath = decodeURIComponent(m[1]); } catch(e) {} }
      }
      const cleanUrl = testPath.split('?')[0].split('#')[0].replace(/\\/g, '/');
      const ext = cleanUrl.split('.').pop()?.toLowerCase() || '';
      if (MEDIA_EXTS.includes(ext)) {
        topMedia = candidate;
        break;
      }
    }
  }

  return (
    <div className={`formatted-markdown text-primary ${className}`}>
      {topMedia && (
        <div className="w-full mb-4">
          <MediaRenderer src={topMedia} />
        </div>
      )}
      <ReactMarkdown
        urlTransform={safeMarkdownUrl}
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings
          h1: ({ children }) => (
            <div className="mt-4 mb-2 pb-1 border-b border-accent-cyan/30 flex items-center gap-2">
              <span className="w-1.5 h-4 bg-accent-cyan rounded-xs shadow-[0_0_8px_rgba(34,211,238,0.6)]" />
              <h1 className="text-sm font-bold text-accent-cyan tracking-wider uppercase">
                {children}
              </h1>
            </div>
          ),
          h2: ({ children }) => (
            <div className="mt-3.5 mb-1.5 pb-0.5 border-b border-accent-cyan/20 flex items-center gap-2">
              <span className="w-1 h-3 bg-accent-cyan/80 rounded-xs" />
              <h2 className="text-[12px] font-bold text-accent-cyan tracking-wide uppercase">
                {children}
              </h2>
            </div>
          ),
          h3: ({ children }) => (
            <h3 className="mt-3 mb-1 text-[10px] font-bold text-primary/70 tracking-[0.2em] uppercase flex items-center gap-1.5">
              <span className="text-accent-cyan text-[9px]">▸</span>
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-2 mb-1 text-[10px] font-semibold text-accent-cyan/80 tracking-widest uppercase">
              {children}
            </h4>
          ),

          // Paragraphs
          p: ({ children }) => (
            <p className={`my-1.5 text-primary/80 leading-relaxed text-[11px] ${compact ? 'my-1' : ''}`}>
              {children}
            </p>
          ),

          // Lists
          ul: ({ children }) => (
            <ul className="my-2 space-y-1 pl-1 text-[11px]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 space-y-1 pl-1 text-[11px] list-none counter-reset-item">
              {children}
            </ol>
          ),
          li: ({ children, node }) => {
            // Check if task item
            const isTask = node && Array.isArray(node.children) && node.children.some(c => c.type === 'element' && (c as any).tagName === 'input');
            if (isTask) {
              return <li className="flex items-start gap-2 my-0.5 text-primary/80 leading-relaxed">{children}</li>;
            }
            return (
              <li className="flex items-start gap-2 my-0.5 text-primary/85 leading-relaxed group">
                <span className="text-accent-cyan shrink-0 mt-0.5 text-[9px] opacity-70 group-hover:opacity-100 transition-opacity select-none">
                  ▸
                </span>
                <span className="flex-1">{children}</span>
              </li>
            );
          },

          // Code blocks & Inline code
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !String(children).includes('\n');
            const codeContent = String(children).replace(/\n$/, '');

            if (isInline) {
              return (
                <code
                  className="bg-accent-cyan/10 border border-accent-cyan/25 text-accent-cyan rounded px-1.5 py-0.5 text-[10px] font-mono font-medium tracking-tight shadow-[0_0_6px_rgba(34,211,238,0.1)] inline-block my-0.5"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            return <CodeBlock language={match ? match[1] : undefined} value={codeContent} />;
          },

          // Blockquotes
          blockquote: ({ children }) => (
            <div className="my-2.5 pl-3 py-1.5 pr-2 border-l-2 border-accent-cyan bg-accent-cyan/5 rounded-r text-[10px] text-primary/75 italic leading-relaxed">
              {children}
            </div>
          ),

          // Links
          a: ({ href, children }) => {
            const cleanHref = href?.split('?')[0].split('#')[0] || '';
            const ext = cleanHref.split('.').pop()?.toLowerCase() || '';
            const isMedia = ['mp4', 'webm', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'm4a', 'pdf', 'txt', 'log', 'csv', 'glb', 'gltf', 'obj', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
            if (isMedia) {
              return <MediaRenderer src={href!} alt={String(children)} />;
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent-cyan hover:underline hover:text-accent-cyan/90 font-medium transition-colors"
                onClick={e => e.stopPropagation()}
              >
                <span>{children}</span>
                <ExternalLink size={9} className="opacity-70 shrink-0" />
              </a>
            );
          },

          // Tables
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded border border-accent-cyan/20 bg-black/40">
              <table className="w-full text-left border-collapse text-[10px]">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-accent-cyan/10 border-b border-accent-cyan/20 text-accent-cyan font-bold tracking-wider uppercase text-[9px]">
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-accent-cyan/10 text-primary/80">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-accent-cyan/5 transition-colors">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-1.5 font-bold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-1.5 leading-relaxed">{children}</td>
          ),

          // Horizontal rule
          hr: () => (
            <div className="my-3 h-px w-full bg-gradient-to-r from-transparent via-accent-cyan/40 to-transparent" />
          ),

          // Images
          img: ({ src, alt }) => {
            return <MediaRenderer src={src!} alt={alt || ''} />;
          },

          // Inputs (task checkboxes)
          input: ({ type, checked }) => {
            if (type === 'checkbox') {
              return (
                <div
                  className={`w-3.5 h-3.5 mt-0.5 rounded border flex items-center justify-center shrink-0 ${
                    checked
                      ? 'border-accent-cyan bg-accent-cyan/20 text-accent-cyan'
                      : 'border-primary/30 bg-black/40'
                  }`}
                >
                  {checked && <Check size={10} className="stroke-[3]" />}
                </div>
              );
            }
            return null;
          },

          // Text formatting
          strong: ({ children }) => (
            <strong className="font-bold text-primary tracking-wide bg-accent-cyan/5 px-1 py-0.2 rounded border-b border-accent-cyan/30">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic text-primary/90">{children}</em>
          ),
          del: ({ children }) => (
            <del className="line-through text-primary/40">{children}</del>
          ),
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};
