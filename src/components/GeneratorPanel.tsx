import { useState } from 'react';
import { 
  Sparkles, 
  Loader, 
  Wand2, 
  Search, 
  Film, 
  Music,
  AlertCircle,
  CheckCircle2,
  Cpu,
  Download
} from 'lucide-react';
import { useBackend, useGeneration, useSemanticSearch } from '../lib/useBackend';
import type { ProviderInfo } from '../lib/api';

interface GeneratorPanelProps {
  onGenerate?: (provider: string, prompt: string, duration: number, variants: number) => void;
  onSearch?: (query: string) => void;
  selectedTimelineRange?: { start: number; end: number };
}

type GeneratorMode = 'text' | 'video' | 'search';

export function GeneratorPanel({ 
  onGenerate,
  onSearch,
  selectedTimelineRange 
}: GeneratorPanelProps) {
  const backend = useBackend();
  const generation = useGeneration();
  const semanticSearch = useSemanticSearch();
  
  const [mode, setMode] = useState<GeneratorMode>('text');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [duration, setDuration] = useState(5);
  const [variants, setVariants] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');

  const getStatusColor = (status: ProviderInfo['status']) => {
    switch (status) {
      case 'ready': return 'text-brine';
      case 'not_installed': return 'text-dim';
      case 'model_missing': return 'text-tan';
      default: return 'text-ember';
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    
    try {
      const results = await generation.generate(
        mode === 'video' ? 'mmaudio' : 'stable_audio',
        {
          prompt,
          negativePrompt: negativePrompt || undefined,
          duration,
          numVariants: variants,
        }
      );
      
      if (results.length > 0 && onGenerate) {
        onGenerate(
          results[0].provider,
          prompt,
          duration,
          results.length
        );
      }
    } catch (e) {
      console.error('Generation failed:', e);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    
    try {
      await semanticSearch.search(searchQuery);
      if (onSearch) onSearch(searchQuery);
    } catch (e) {
      console.error('Search failed:', e);
    }
  };

  return (
    <div className="glass-deep neon-t rounded-xl overflow-hidden">
      <header className="flex items-center gap-3 border-b border-white/[0.06] px-3.5 py-2.5">
        <Sparkles size={14} className="text-orchid" />
        <h3 className="font-display text-[13px] font-semibold text-bone">Generator</h3>
        {backend.connected && (
          <span className="chip text-brine border-brine/40">
            <CheckCircle2 size={9} /> Backend ready
          </span>
        )}
      </header>

      <div className="p-3.5 space-y-4">
        {/* Mode Tabs */}
        <div className="flex gap-1.5">
          {[
            { id: 'text', label: 'Text → Audio', icon: Wand2 },
            { id: 'video', label: 'Video → Audio', icon: Film },
            { id: 'search', label: 'Library Search', icon: Search },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setMode(id as GeneratorMode)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[10.5px] transition-all ${
                mode === id 
                  ? 'bg-violet/20 border border-orchid/40 text-bone' 
                  : 'border border-white/[0.06] text-dim hover:text-ash hover:border-white/12'
              }`}
            >
              <Icon size={11} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        {/* Provider Status */}
        <div className="space-y-1.5">
          <span className="eyebrow">Available Providers</span>
          {backend.providers.map((p) => (
            <div 
              key={p.name}
              className="flex items-center gap-2 text-[10.5px]"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${
                p.status === 'ready' ? 'bg-brine' : 'bg-dim'
              }`} />
              <span className="text-ash">{p.display_name}</span>
              <span className={`ml-auto ${getStatusColor(p.status)}`}>
                {p.status === 'ready' ? (
                  <CheckCircle2 size={10} />
                ) : p.status === 'not_installed' ? (
                  <Cpu size={10} />
                ) : (
                  <AlertCircle size={10} />
                )}
              </span>
            </div>
          ))}
          
          {!backend.connected && (
            <p className="text-[10px] text-tan">
              Connect to backend for ML features
            </p>
          )}
        </div>

        {/* Text Generation */}
        {mode === 'text' && (
          <div className="space-y-3">
            <div>
              <label className="eyebrow block mb-1">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="thin corroded metal scraping behind a concrete wall, distant, sparse, no music"
                className="w-full h-20 bg-black/30 border border-white/[0.08] rounded-lg px-3 py-2 text-[11px] text-bone placeholder:text-dim resize-none focus:outline-none focus:border-orchid/40"
              />
            </div>

            <div>
              <label className="eyebrow block mb-1">Negative Prompt (optional)</label>
              <input
                type="text"
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="music, dialogue, bright sounds"
                className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-[11px] text-bone placeholder:text-dim focus:outline-none focus:border-orchid/40"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="eyebrow block mb-1">Duration (s)</label>
                <input
                  type="number"
                  value={duration}
                  onChange={(e) => setDuration(Math.max(0.5, Math.min(120, parseFloat(e.target.value) || 5)))}
                  min={0.5}
                  max={120}
                  step={0.5}
                  className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-[11px] text-bone focus:outline-none focus:border-orchid/40"
                />
              </div>
              <div>
                <label className="eyebrow block mb-1">Variants</label>
                <input
                  type="number"
                  value={variants}
                  onChange={(e) => setVariants(Math.max(1, Math.min(5, parseInt(e.target.value) || 1)))}
                  min={1}
                  max={5}
                  className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-[11px] text-bone focus:outline-none focus:border-orchid/40"
                />
              </div>
            </div>

            <button
              onClick={handleGenerate}
              disabled={generation.generating || !prompt.trim() || !backend.connected}
              className="btn btn-primary w-full justify-center disabled:opacity-50"
            >
              {generation.generating ? (
                <>
                  <Loader size={12} className="animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles size={12} />
                  Generate
                </>
              )}
            </button>
          </div>
        )}

        {/* Video Generation */}
        {mode === 'video' && (
          <div className="space-y-3">
            <p className="text-[10.5px] text-dim">
              Select a video range in the timeline, then generate synchronized audio.
            </p>
            
            {selectedTimelineRange && (
              <div className="bg-black/30 rounded-lg px-3 py-2 text-[10.5px]">
                <span className="text-dim">Selected range: </span>
                <span className="tnum text-bone">
                  {selectedTimelineRange.start.toFixed(2)}s → {selectedTimelineRange.end.toFixed(2)}s
                </span>
                <span className="text-dim ml-2">
                  ({(selectedTimelineRange.end - selectedTimelineRange.start).toFixed(1)}s)
                </span>
              </div>
            )}

            <div>
              <label className="eyebrow block mb-1">Prompt (optional)</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="subtle physical movement and Foley only, no music"
                className="w-full h-16 bg-black/30 border border-white/[0.08] rounded-lg px-3 py-2 text-[11px] text-bone placeholder:text-dim resize-none focus:outline-none focus:border-orchid/40"
              />
            </div>

            <button
              onClick={handleGenerate}
              disabled={generation.generating || !backend.connected}
              className="btn btn-primary w-full justify-center disabled:opacity-50"
            >
              {generation.generating ? (
                <>
                  <Loader size={12} className="animate-spin" />
                  Generating from video...
                </>
              ) : (
                <>
                  <Film size={12} />
                  Generate from Video
                </>
              )}
            </button>
          </div>
        )}

        {/* Semantic Search */}
        {mode === 'search' && (
          <div className="space-y-3">
            <div>
              <label className="eyebrow block mb-1">Search Library</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="distant metallic resonance"
                  className="flex-1 bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-[11px] text-bone placeholder:text-dim focus:outline-none focus:border-orchid/40"
                />
                <button
                  onClick={handleSearch}
                  disabled={semanticSearch.searching || !searchQuery.trim()}
                  className="btn disabled:opacity-50"
                >
                  {semanticSearch.searching ? (
                    <Loader size={12} className="animate-spin" />
                  ) : (
                    <Search size={12} />
                  )}
                </button>
              </div>
            </div>

            {semanticSearch.results.length > 0 && (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                <span className="eyebrow">Results</span>
                {semanticSearch.results.map((result, i) => (
                  <div 
                    key={result.audio_id}
                    className="flex items-center gap-2 bg-black/20 rounded-lg px-2.5 py-1.5 text-[10.5px]"
                  >
                    <span className="tnum text-dim w-5">{i + 1}.</span>
                    <span className="flex-1 truncate text-ash">{result.prompt || 'No description'}</span>
                    <span className="tnum text-brine">
                      {(result.similarity * 100).toFixed(0)}%
                    </span>
                    <button className="text-dim hover:text-bone" title="Audition">
                      <Music size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {semanticSearch.error && (
              <p className="text-[10px] text-tan">{semanticSearch.error}</p>
            )}
          </div>
        )}

        {/* Generation Results */}
        {generation.results.length > 0 && (
          <div className="space-y-1.5">
            <span className="eyebrow">Generated</span>
            {generation.results.map((result, i) => (
              <div 
                key={result.id}
                className="flex items-center gap-2 bg-black/20 rounded-lg px-2.5 py-1.5 text-[10.5px]"
              >
                <span className="tnum text-dim w-5">
                  {String.fromCharCode(65 + i)}.
                </span>
                <span className={`flex-1 ${result.status === 'failed' ? 'text-tan' : 'text-ash'}`}>
                  {result.status === 'failed' ? result.error : 'Ready'}
                </span>
                {result.status === 'complete' && (
                  <>
                    <button className="text-dim hover:text-bone" title="Audition">
                      <Music size={10} />
                    </button>
                    <button className="text-dim hover:text-bone" title="Download">
                      <Download size={10} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {generation.error && (
          <p className="text-[10px] text-tan">{generation.error}</p>
        )}

        {/* Device Info */}
        {backend.device && (
          <div className="border-t border-white/[0.06] pt-3">
            <div className="flex items-center gap-2 text-[10px] text-dim">
              <Cpu size={10} />
              <span>{backend.device.device_name}</span>
              {backend.device.gpu_memory_total && (
                <span className="ml-auto">
                  {(backend.device.gpu_memory_total / 1024**3).toFixed(1)} GB
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
