import React from 'react';
import { motion } from 'framer-motion';
import { Youtube, BookOpen, Library, Clock, ExternalLink, Search, Play, ShieldCheck, AlertTriangle, Code, FileText, Folder, FolderOpen, ChevronDown, ChevronUp, ChevronRight, Loader2 } from 'lucide-react';
import { API_BASE } from '../config/api';

const RESOURCE_TABS = [
    { id: 'youtube', label: 'YouTube', icon: Youtube },
    { id: 'articles', label: 'Articles', icon: BookOpen },
    { id: 'books', label: 'Books', icon: Library },
    { id: 'code', label: 'Code', icon: Code },
];

const RESOURCE_TYPE_BY_TAB = {
    youtube: 'youtube',
    articles: 'article',
    books: 'book',
    code: 'code',
};

// Helper: open URL in new tab without affecting current page state
const openLink = (url, e) => {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    window.open(url, '_blank', 'noopener,noreferrer');
};

const AccessBadge = ({ accessMode }) => {
    const isFullText = accessMode === 'full_text_allowed';
    return (
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
            isFullText
                ? 'border-blue-500/20 bg-blue-500/10 text-blue-300'
                : 'border-gray-600/30 bg-gray-700/30 text-gray-400'
        }`}>
            {isFullText ? <ShieldCheck className="w-2.5 h-2.5" /> : <AlertTriangle className="w-2.5 h-2.5" />}
            {isFullText ? 'Full text' : 'Metadata'}
        </span>
    );
};

const TrustBadge = ({ trustTier, trustScore }) => {
    if (!trustTier && !trustScore) return null;
    const isAuthoritative = trustTier === 'authoritative_metadata' || trustScore >= 70;
    return (
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
            isAuthoritative
                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                : 'border-gray-600/30 bg-gray-700/30 text-gray-400'
        }`}>
            {isAuthoritative ? 'High trust' : 'Review'}
        </span>
    );
};

const ResourceGroundingSummary = ({ coverage }) => {
    if (!coverage) return null;

    const tone = coverage.coverage_level === 'high'
        ? 'border-blue-500/20 bg-blue-500/10 text-blue-300'
        : coverage.coverage_level === 'medium'
            ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
            : 'border-gray-600/30 bg-gray-800/40 text-gray-400';

    return (
        <div className={`rounded-xl border px-3 py-2 ${tone}`}>
            <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-black uppercase tracking-widest">Source coverage: {coverage.coverage_level}</span>
                <span className="text-[10px] opacity-80">{coverage.fact_count || 0} facts</span>
            </div>
        </div>
    );
};

const ResourceLearningTasks = ({ tasks = [], activeTab }) => {
    const resourceType = RESOURCE_TYPE_BY_TAB[activeTab];
    const visibleTasks = tasks.filter(task => task.resource_type === resourceType);
    if (!visibleTasks.length) return null;

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
                <h3 className="text-white font-bold text-sm">Learning Tasks</h3>
            </div>
            <div className="space-y-2">
                {visibleTasks.map(task => (
                    <div key={task.id} className="rounded-xl border border-gray-700/40 bg-gray-800/35 p-3">
                        <div className="flex items-start justify-between gap-3">
                            <p className="text-xs font-semibold text-gray-200 leading-relaxed">{task.resource_title}</p>
                            <AccessBadge accessMode="metadata_only" />
                        </div>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">{task.task}</p>
                    </div>
                ))}
            </div>
        </div>
    );
};

// ─── YouTube Video Card ─────────────────────────────────────────────────────

const timeAgo = (dateString) => {
    if (!dateString) return '';
    try {
        const date = new Date(dateString);
        const now = new Date();
        const seconds = Math.floor((now - date) / 1000);
        if (isNaN(seconds) || seconds < 0) return '';

        const intervals = {
            year: 31536000,
            month: 2592000,
            week: 604800,
            day: 86400,
            hour: 3600,
            minute: 60,
        };

        for (const [unit, value] of Object.entries(intervals)) {
            const count = Math.floor(seconds / value);
            if (count >= 1) {
                return `${count} ${unit}${count > 1 ? 's' : ''} ago`;
            }
        }
        return 'just now';
    } catch (e) {
        return '';
    }
};

const formatViewCount = (count) => {
    if (count === undefined || count === null) return '';
    const num = Number(count);
    if (isNaN(num)) return '';
    if (num >= 1000000) {
        return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
    }
    if (num >= 1000) {
        return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
    }
    return `${num} view${num !== 1 ? 's' : ''}`;
};

const formatDuration = (durationStr) => {
    if (!durationStr) return '';
    try {
        const matches = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (!matches) return '';
        const hours = parseInt(matches[1] || '0', 10);
        const minutes = parseInt(matches[2] || '0', 10);
        const seconds = parseInt(matches[3] || '0', 10);

        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    } catch (e) {
        return '';
    }
};

const YouTubeCard = ({ video, index }) => {
    const [isPlaying, setIsPlaying] = React.useState(false);
    const searchQuery = video.search_query || `${video.channel || ''} ${video.title || ''}`.trim();
    const fallbackUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
    // Backend resolves real video URLs via Piped API; fallback to search
    const videoUrl = video.url || fallbackUrl;
    const isApiSearchVideo = video.source_bucket === 'youtube_api_search';
    const isLocalSubscriptionVideo = video.source_bucket === 'subscription_local_search';
    const displayRank = video.display_rank || index + 1;
    const originalRank = video.youtube_rank || video.original_rank;
    const videoDescription = video.description || video.snippet_description;
    const cardTone = isLocalSubscriptionVideo
        ? 'bg-red-950/20 border-red-500/40 hover:border-red-400/60 hover:shadow-red-500/10'
        : 'bg-gray-800/50 border-gray-700/40 hover:border-red-500/30 hover:shadow-red-500/5';
    
    const getYouTubeId = (url) => {
        if (!url) return null;
        const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
        const match = url.match(regExp);
        return (match && match[2].length === 11) ? match[2] : null;
    };
    
    const videoId = getYouTubeId(videoUrl);
    const isDirect = !!videoId;

    const handleCardClick = (e) => {
        if (isDirect) {
            e.preventDefault();
            e.stopPropagation();
            if(!isPlaying) setIsPlaying(true);
        } else {
            openLink(videoUrl, e);
        }
    };

    if (isPlaying && isDirect) {
        return (
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="block bg-gray-900 border border-gray-700/40 rounded-2xl overflow-hidden shadow-lg transition-all group relative"
            >
                <div className="relative w-full pt-[56.25%]">
                    <iframe
                        className="absolute top-0 left-0 w-full h-full"
                        src={`https://www.youtube.com/embed/${videoId}?autoplay=1`}
                        title={video.title}
                        frameBorder="0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                    ></iframe>
                </div>
                <div className="p-3 flex justify-between items-center bg-gray-800 border-t border-gray-700/50">
                    <p className="resource-card-title text-xs font-semibold truncate flex-1">{video.title}</p>
                    <button 
                        onClick={(e) => { e.stopPropagation(); setIsPlaying(false); }}
                        className="text-gray-400 hover:text-white px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-[10px] ml-2 transition-colors font-semibold shadow-sm"
                    >
                        Close Video
                    </button>
                </div>
            </motion.div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.08 }}
            onClick={handleCardClick}
            className={`block border rounded-2xl p-4 hover:shadow-lg transition-all group cursor-pointer ${cardTone}`}
        >
            {/* Thumbnail-like header */}
            <div className="bg-gradient-to-br from-red-500/10 to-red-900/20 rounded-xl p-3 mb-3 flex items-center gap-3 relative overflow-hidden">
                <div className="bg-red-600 w-10 h-10 rounded-lg flex items-center justify-center shadow-lg flex-shrink-0">
                    <Play className="w-5 h-5 text-white fill-white" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="resource-card-title text-xs font-semibold truncate group-hover:text-red-300 transition-colors">
                        {video.title}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <p className="text-gray-500 text-[10px]">
                            {video.channel || video.suggested_channel}
                            {video.published_at && (
                                <span className="opacity-80">
                                    {' • '}{timeAgo(video.published_at) || new Date(video.published_at).toLocaleDateString()}
                                </span>
                            )}
                            {video.view_count !== undefined && video.view_count !== null && (
                                <span className="opacity-80">
                                    {' • '}{formatViewCount(video.view_count)}
                                </span>
                            )}
                            {video.duration && (
                                <span className="opacity-80">
                                    {' • '}{formatDuration(video.duration)}
                                </span>
                            )}
                        </p>
                        {isApiSearchVideo && video.from_subscription && (
                            <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-gray-700/50 text-gray-300 border border-gray-600/40">
                                Subscribed channel
                            </span>
                        )}
                    </div>
                    {videoDescription && (
                        <p className="text-gray-400 text-[10px] leading-relaxed mt-1 line-clamp-2">
                            {videoDescription}
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {isLocalSubscriptionVideo && (
                        <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
                            ✓ Subscribed
                        </span>
                    )}
                    {isApiSearchVideo && (
                        <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-red-600/20 text-red-300 border border-red-500/30">
                            #{displayRank}
                        </span>
                    )}
                    {isApiSearchVideo && originalRank && originalRank !== displayRank && (
                        <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-gray-700/40 text-gray-400 border border-gray-600/30">
                            Search {originalRank}
                        </span>
                    )}
                    {isDirect ? (
                        <Play className="w-3.5 h-3.5 text-gray-600 group-hover:text-red-400 transition-colors" />
                    ) : (
                        <ExternalLink className="w-3.5 h-3.5 text-gray-600 group-hover:text-red-400 transition-colors" />
                    )}
                </div>
            </div>

            {/* Broad watch focus. Exact timestamps require transcript/chapter data. */}
            {!isApiSearchVideo && (video.suggested_section || video.snippet_timestamp) && video.snippet_description && (
                <div className="bg-red-500/5 border border-red-500/10 rounded-lg px-3 py-2 mb-2.5">
                    <div className="flex items-center gap-2">
                        <Clock className="w-3 h-3 text-red-400 flex-shrink-0" />
                        <span className="text-red-400 text-[11px] font-mono font-bold">
                            Suggested: {video.suggested_section || video.snippet_timestamp}
                        </span>
                    </div>
                    <p className="text-gray-400 text-[10px] mt-1 leading-relaxed">
                        {video.snippet_description}
                    </p>
                </div>
            )}

            {!isApiSearchVideo && video.why_relevant && (
                <p className="text-gray-500 text-[10px] leading-relaxed mb-2">{video.why_relevant}</p>
            )}

            {/* Link type indicator */}
            <div className="flex items-center gap-1.5 text-[9px] text-gray-600">
                {isDirect ? (
                    <><Play className="w-2.5 h-2.5 text-green-500" /><span className="font-mono truncate text-green-600">Click to play video inside app</span></>
                ) : (
                    <><Search className="w-2.5 h-2.5" /><span className="font-mono truncate">{searchQuery}</span></>
                )}
            </div>
        </motion.div>
    );
};

// ─── Article Card ───────────────────────────────────────────────────────────

const ArticleCard = ({ article, index }) => {
    // Backend resolves real article URLs via DuckDuckGo; fallback to Google search
    const searchTerm = article.search_query || `${article.title || ''} ${article.source || ''}`.trim();
    const articleUrl = article.url || `https://www.google.com/search?q=${encodeURIComponent(searchTerm)}`;
    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + index * 0.08 }}
            onClick={(e) => openLink(articleUrl, e)}
            className="block bg-gray-800/50 border border-gray-700/40 rounded-2xl p-4 hover:border-blue-500/30 hover:shadow-lg hover:shadow-blue-500/5 transition-all group cursor-pointer"
        >
            <div className="flex items-start gap-3">
                <div className="bg-blue-600/20 w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden border border-blue-500/20">
                    {article.image ? (
                        <img src={article.image} alt={article.title} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity" />
                    ) : (
                        <BookOpen className="w-4 h-4 text-blue-400" />
                    )}
                </div>
                <div className="flex-1 min-w-0 py-0.5">
                    <p className="resource-card-title text-xs font-semibold group-hover:text-blue-300 transition-colors truncate" title={article.title}>
                        {article.title}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <p className="text-gray-500 text-[10px]">{article.source}</p>
                        <AccessBadge accessMode={article.access_mode} />
                        <TrustBadge trustTier={article.trust_tier} trustScore={article.trust_score} />
                    </div>
                    {article.url && (
                        <p className="mt-1 text-[9px] text-gray-500 font-mono truncate" title={article.url}>
                            {article.url}
                        </p>
                    )}
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-gray-600 group-hover:text-blue-400 transition-colors flex-shrink-0 mt-0.5" />
            </div>

            <p className="text-gray-400 text-[10px] leading-relaxed mt-2">{article.why_relevant}</p>

            <div className="flex items-center justify-between mt-2.5">
                {article.key_takeaway && (
                    <p className="text-blue-400/70 text-[10px] italic flex-1 mr-3">💡 {article.key_takeaway}</p>
                )}
                {article.estimated_read_time && (
                    <span className="text-gray-600 text-[10px] flex items-center gap-1 flex-shrink-0">
                        <Clock className="w-2.5 h-2.5" />
                        {article.estimated_read_time}
                    </span>
                )}
            </div>
        </motion.div>
    );
};

// ─── Book Card ──────────────────────────────────────────────────────────────

const BookCard = ({ book, index }) => {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(book.title + ' ' + book.author + ' book')}`;

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 + index * 0.08 }}
            onClick={(e) => openLink(searchUrl, e)}
            className="block bg-gray-800/50 border border-gray-700/40 rounded-2xl p-4 hover:border-purple-500/30 hover:shadow-lg hover:shadow-purple-500/5 transition-all group cursor-pointer"
        >
            <div className="flex items-start gap-3">
                <div className="bg-purple-600/20 w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Library className="w-4 h-4 text-purple-400" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="resource-card-title text-xs font-semibold group-hover:text-purple-300 transition-colors">
                        {book.title}
                    </p>
                    <p className="text-gray-500 text-[10px]">by {book.author}</p>
                </div>
            </div>
            {book.relevant_chapter && (
                <p className="text-purple-400/60 text-[10px] mt-2">📖 {book.relevant_chapter}</p>
            )}
            <p className="text-gray-500 text-[10px] leading-relaxed mt-1">{book.why_relevant}</p>
        </motion.div>
    );
};

const ResourceEmptyState = ({ icon, label }) => {
    const EmptyIcon = icon;

    return (
        <div className="flex flex-col items-center justify-center py-12 text-gray-500">
            <EmptyIcon className="w-9 h-9 mb-3 opacity-30" />
            <p className="text-sm italic text-center">{label}</p>
        </div>
    );
};

const QueryCaption = ({ query }) => {
    if (!query) return null;
    return (
        <p className="mb-3 rounded-xl border border-gray-700/30 bg-gray-900/30 px-3 py-2 text-[10px] leading-relaxed text-gray-400">
            Found results for <span className="font-mono text-gray-300">"{query}"</span>
        </p>
    );
};

const buildCodeTree = (files = [], references = []) => {
    const root = { name: '', path: '', type: 'folder', children: new Map() };
    const paths = [...new Set([
        ...files.map(file => file.filePath || file.path).filter(Boolean),
        ...references.map(reference => reference.filePath).filter(Boolean),
    ])].sort((a, b) => a.localeCompare(b));

    for (const path of paths) {
        const parts = path.split('/').filter(Boolean);
        let current = root;
        parts.forEach((part, index) => {
            const currentPath = parts.slice(0, index + 1).join('/');
            if (!current.children.has(part)) {
                current.children.set(part, {
                    name: part,
                    path: currentPath,
                    type: index === parts.length - 1 ? 'file' : 'folder',
                    children: new Map(),
                });
            }
            current = current.children.get(part);
        });
    }

    const toArray = node => ({
        ...node,
        children: [...node.children.values()]
            .map(toArray)
            .sort((a, b) => {
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                return a.name.localeCompare(b.name);
            }),
    });

    return toArray(root).children;
};

const addMatchedFlagToTree = (nodes, matchedFileScores) => {
    return nodes.map(node => {
        if (node.type === 'file') {
            const isMatched = matchedFileScores.has(node.path);
            return {
                ...node,
                isMatched,
                hasMatchedChild: isMatched
            };
        } else {
            const children = addMatchedFlagToTree(node.children || [], matchedFileScores);
            const hasMatchedChild = children.some(c => c.hasMatchedChild);
            return {
                ...node,
                children,
                hasMatchedChild
            };
        }
    });
};

const CodeTreeNode = ({ node, depth = 0, activeFilePath, matchedFileScores, scoreRange, onSelectFile }) => {
    const isFile = node.type === 'file';
    const score = matchedFileScores?.get(node.path);
    const isMatched = node.isMatched;
    const isActive = activeFilePath === node.path;

    const [isExpanded, setIsExpanded] = React.useState(node.hasMatchedChild);

    React.useEffect(() => {
        setIsExpanded(node.hasMatchedChild);
    }, [node.hasMatchedChild, node.path]);

    const handleClick = (e) => {
        if (isFile) {
            onSelectFile(node.path);
        } else {
            setIsExpanded(prev => !prev);
        }
    };

    let itemClasses = 'code-tree-node';
    if (isFile) {
        itemClasses += ' is-file';
        if (isActive) {
            itemClasses += ' is-active';
        } else if (isMatched) {
            itemClasses += ' is-matched';
        }
    } else {
        itemClasses += ' is-folder';
        if (node.hasMatchedChild) {
            itemClasses += ' has-matched-child';
        }
    }

    const scoreVal = Number(score || 0);
    const min = scoreRange?.min ?? 0.65;
    const max = scoreRange?.max ?? 1.0;
    const normalized = max > min ? Math.max(0, Math.min(1, (scoreVal - min) / (max - min))) : 1.0;

    const hue = Math.round(210 - normalized * (210 - 142));
    const saturation = Math.round(20 + normalized * 65);
    const lightness = Math.round(65 - normalized * 15);

    const cssVars = isFile && isMatched ? {
        '--hl-h': hue,
        '--hl-s': `${saturation}%`,
        '--hl-l': `${lightness}%`,
    } : {};

    return (
        <div>
            <button
                type="button"
                onClick={handleClick}
                className={itemClasses}
                style={{
                    paddingLeft: `${8 + depth * 12}px`,
                    ...cssVars
                }}
                title={node.path}
            >
                {!isFile ? (
                    isExpanded 
                        ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                        : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                ) : (
                    <div className="h-3.5 w-3.5 flex-shrink-0" />
                )}

                {isFile ? (
                    <FileText className={`h-3.5 w-3.5 flex-shrink-0 ${isMatched ? 'text-emerald-400 icon-matched' : 'text-gray-500'}`} />
                ) : (
                    isExpanded
                        ? <FolderOpen className={`h-3.5 w-3.5 flex-shrink-0 ${node.hasMatchedChild ? 'text-emerald-400 icon-matched' : 'text-blue-400'}`} />
                        : <Folder className={`h-3.5 w-3.5 flex-shrink-0 ${node.hasMatchedChild ? 'text-emerald-400 icon-matched' : 'text-blue-400'}`} />
                )}

                <span className="truncate">{node.name}</span>

                {isMatched && (
                    <span className="code-file-badge-ide ml-auto flex-shrink-0 rounded px-1 py-0.5 text-[8px] font-bold">
                        {Math.round(score * 100)}%
                    </span>
                )}
            </button>
            {!isFile && isExpanded && node.children?.map(child => (
                <CodeTreeNode
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    activeFilePath={activeFilePath}
                    matchedFileScores={matchedFileScores}
                    scoreRange={scoreRange}
                    onSelectFile={onSelectFile}
                />
            ))}
        </div>
    );
};

const formatCodeConfidence = (score) => {
    const numericScore = Number(score);
    if (!Number.isFinite(numericScore)) return '';
    const percent = numericScore <= 1 ? Math.round(numericScore * 100) : Math.round(numericScore);
    return `(${percent}%)`;
};

const highlightLine = (line, language = 'javascript') => {
    if (!line || !line.trim()) return line || ' ';

    // Escape HTML entities to prevent rendering conflicts
    let html = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // 1. Comments
    let comment = '';
    const commentRegex = /(\/\/.*|#.*)/;
    const commentMatch = html.match(commentRegex);
    if (commentMatch) {
        comment = commentMatch[0];
        html = html.replace(comment, '___COMMENT_PLACEHOLDER___');
    }

    // 2. Strings
    const strings = [];
    const stringRegex = /(["'`])((?:\\.|[^\\])*?)\1/g;
    html = html.replace(stringRegex, (match) => {
        strings.push(match);
        return `___STRING_PLACEHOLDER_${strings.length - 1}___`;
    });

    // 3. Keywords
    const keywords = [
        'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default',
        'class', 'extends', 'def', 'if', 'else', 'for', 'in', 'of', 'while',
        'try', 'catch', 'finally', 'throw', 'new', 'async', 'await', 'from',
        'true', 'false', 'null', 'undefined', 'as', 'break', 'continue', 'pass', 'elif'
    ];
    const keywordsRegex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g');
    html = html.replace(keywordsRegex, '<span class="code-hl-keyword">$1</span>');

    // 4. Function invocations/definitions
    const funcRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/g;
    html = html.replace(funcRegex, '<span class="code-hl-function">$1</span>');

    // 5. Numbers
    const numRegex = /\b(\d+(?:\.\d+)?)\b/g;
    html = html.replace(numRegex, '<span class="code-hl-number">$1</span>');

    // 6. Built-in hooks / objects
    const builtins = ['console', 'window', 'document', 'process', 'global', 'self', 'React', 'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback'];
    const builtinsRegex = new RegExp(`\\b(${builtins.join('|')})\\b`, 'g');
    html = html.replace(builtinsRegex, '<span class="code-hl-builtin">$1</span>');

    // 7. JSX Tag outlines
    const tagRegex = /(&lt;\/?[a-z0-9_$]+)/gi;
    html = html.replace(tagRegex, '<span class="code-hl-tag">$1</span>');
    const closingTagRegex = /(\/&gt;|&gt;)/g;
    html = html.replace(closingTagRegex, '<span class="code-hl-tag">$1</span>');

    // 8. Restore strings
    strings.forEach((str, i) => {
        html = html.replace(`___STRING_PLACEHOLDER_${i}___`, `<span class="code-hl-string">${str}</span>`);
    });

    // 9. Restore comments
    if (comment) {
        html = html.replace('___COMMENT_PLACEHOLDER___', `<span class="code-hl-comment">${comment}</span>`);
    }

    return <span dangerouslySetInnerHTML={{ __html: html }} />;
};

const CodeBlockWithHighlights = ({ code, startLine = 1, highlightStart, highlightEnd, highlightRanges = [], focusStartLine, language }) => {
    const lines = String(code || '').split(/\r?\n/);
    const firstLine = Number(startLine || 1);
    const start = Number(highlightStart);
    const end = Number(highlightEnd);
    const ranges = highlightRanges.length
        ? highlightRanges
            .map(range => ({
                start: Number(range.start),
                end: Number(range.end),
            }))
            .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end))
        : Number.isFinite(start) && Number.isFinite(end)
            ? [{ start, end }]
            : [];

    const containerRef = React.useRef(null);

    React.useEffect(() => {
        if (containerRef.current) {
            const scrollTargetLine = Number.isFinite(focusStartLine) ? focusStartLine : (ranges[0]?.start || firstLine);
            const targetIndex = scrollTargetLine - firstLine;
            if (targetIndex >= 0 && targetIndex < lines.length) {
                const preElement = containerRef.current;
                const codeElement = preElement.querySelector('code');
                if (codeElement) {
                    setTimeout(() => {
                        const targetEl = codeElement.children[targetIndex];
                        if (targetEl) {
                            preElement.scrollTop = targetEl.offsetTop - (preElement.clientHeight / 2);
                        }
                    }, 50);
                }
            }
        }
    }, [code, firstLine, ranges, focusStartLine]);

    return (
        <pre 
            ref={containerRef}
            className="code-viewer-pre overflow-auto p-0 text-[11px] leading-relaxed text-gray-300 custom-scrollbar"
        >
            <code className="block py-2">
                {lines.map((line, index) => {
                    const lineNumber = firstLine + index;
                    const highlighted = ranges.some(range => lineNumber >= range.start && lineNumber <= range.end);
                    return (
                        <span
                            key={`${lineNumber}-${index}`}
                            className={`grid grid-cols-[3rem_minmax(0,1fr)] gap-3 px-3 ${
                                highlighted ? 'bg-emerald-500/15 text-emerald-100' : ''
                            }`}
                        >
                            <span className={`select-none text-right ${highlighted ? 'text-emerald-300' : 'text-gray-600'}`}>
                                {lineNumber}
                            </span>
                            <span className="whitespace-pre-wrap break-words">{highlightLine(line, language)}</span>
                        </span>
                    );
                })}
            </code>
        </pre>
    );
};

const CodeEvidencePanel = ({ selectedNode, userId }) => {
    if (!selectedNode?.repoConcept) return null;
    const references = selectedNode?.code_references || [];
    const codeFiles = selectedNode?.code_files || [];
    const [expanded, setExpanded] = React.useState(false);
    const [queryExpanded, setQueryExpanded] = React.useState(false);
    const [activeIndex, setActiveIndex] = React.useState(0);
    const [activeFilePath, setActiveFilePath] = React.useState('');
    const [showFullFile, setShowFullFile] = React.useState(false);
    const [fullFiles, setFullFiles] = React.useState({});
    const [loadingFile, setLoadingFile] = React.useState(false);
    const [fileError, setFileError] = React.useState('');

    // Keyword interactive search states
    const [searchResultReferences, setSearchResultReferences] = React.useState(null);
    const [selectedKeyword, setSelectedKeyword] = React.useState(null);
    const [loadingKeyword, setLoadingKeyword] = React.useState(null);
    const [keywordError, setKeywordError] = React.useState('');

    // Sidebar adjustable width states
    const [treeWidth, setTreeWidth] = React.useState(() => {
        const saved = Number(sessionStorage.getItem('questmap_tree_width'));
        return Number.isFinite(saved) && saved >= 120 ? saved : 180;
    });
    const [isResizingTree, setIsResizingTree] = React.useState(false);
    const containerRef = React.useRef(null);

    const handleTreeResizeStart = React.useCallback((event) => {
        event.preventDefault();
        setIsResizingTree(true);
    }, []);

    React.useEffect(() => {
        if (!isResizingTree) return undefined;

        const handlePointerMove = (event) => {
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                const nextWidth = Math.max(120, Math.min(450, event.clientX - rect.left));
                setTreeWidth(nextWidth);
            }
        };

        const handlePointerUp = () => {
            setIsResizingTree(false);
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);

        return () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };
    }, [isResizingTree]);

    React.useEffect(() => {
        sessionStorage.setItem('questmap_tree_width', String(treeWidth));
    }, [treeWidth]);

    const activeReferences = searchResultReferences !== null ? searchResultReferences : references;

    const matchedFileScores = React.useMemo(() => {
        const scores = new Map();
        for (const ref of activeReferences) {
            if (!ref.filePath) continue;
            const score = Number(ref.score || ref.relevance || 0);
            const currentMax = scores.get(ref.filePath) || 0;
            if (score > currentMax) {
                scores.set(ref.filePath, score);
            }
        }
        return scores;
    }, [activeReferences]);

    const scoreRange = React.useMemo(() => {
        const scores = activeReferences.map(ref => Number(ref.score || ref.relevance || 0)).filter(s => s > 0);
        if (scores.length === 0) {
            return { min: 0.65, max: 1.0 };
        }
        return {
            min: Math.min(...scores),
            max: Math.max(...scores),
        };
    }, [activeReferences]);

    const tree = React.useMemo(() => {
        const rawTree = buildCodeTree(codeFiles, activeReferences);
        return addMatchedFlagToTree(rawTree, matchedFileScores);
    }, [codeFiles, activeReferences, matchedFileScores]);

    const visibleReferences = React.useMemo(() => {
        const filtered = activeFilePath
            ? activeReferences.filter(reference => reference.filePath === activeFilePath)
            : activeReferences;
        return [...filtered].sort((a, b) => (
            String(a.filePath || '').localeCompare(String(b.filePath || '')) ||
            Number(a.startLine || 0) - Number(b.startLine || 0) ||
            Number(a.endLine || 0) - Number(b.endLine || 0)
        ));
    }, [activeFilePath, activeReferences]);

    React.useEffect(() => {
        setExpanded(Boolean(references.length));
        setQueryExpanded(false);
        setActiveIndex(0);
        setActiveFilePath(references[0]?.filePath || codeFiles[0]?.filePath || '');
        setShowFullFile(false);
        setFileError('');
        setSearchResultReferences(null);
        setSelectedKeyword(null);
        setLoadingKeyword(null);
        setKeywordError('');
    }, [selectedNode?.id, references, codeFiles]);

    React.useEffect(() => {
        if (!activeFilePath) return;
        const fileRefs = activeReferences.filter(r => r.filePath === activeFilePath);
        if (fileRefs.length > 1) {
            setShowFullFile(true);
            const activeCodeFile = codeFiles.find(file => (file.filePath || file.path) === activeFilePath);
            const activeFileId = activeCodeFile?.fileId;
            if (activeFileId && !fullFiles[activeFileId]) {
                const fetchFullFile = async () => {
                    setLoadingFile(true);
                    setFileError('');
                    try {
                        const requestUserId = userId || sessionStorage.getItem('questmap_uid') || 'anonymous';
                        const response = await fetch(`${API_BASE}/repo/code/file/${activeFileId}?userId=${encodeURIComponent(requestUserId)}`);
                        const data = await response.json().catch(() => ({}));
                        if (!response.ok) throw new Error(data.details || data.error || 'Unable to load full file');
                        setFullFiles(current => ({ ...current, [activeFileId]: data }));
                    } catch (err) {
                        setFileError(err.message);
                    } finally {
                        setLoadingFile(false);
                    }
                };
                fetchFullFile();
            }
        } else {
            setShowFullFile(false);
        }
    }, [activeFilePath, activeReferences, codeFiles, userId]);

    const searchCodeByKeyword = async (keyword) => {
        setLoadingKeyword(keyword);
        setKeywordError('');
        try {
            const requestUserId = userId || sessionStorage.getItem('questmap_uid') || 'anonymous';
            const response = await fetch(`${API_BASE}/repo/code/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: requestUserId,
                    repoFullName: selectedNode.repoFullName,
                    keyword: keyword,
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to search code');
            
            const refs = data.references || [];
            setSearchResultReferences(refs);
            setSelectedKeyword(keyword);
            
            if (refs.length > 0) {
                setActiveFilePath(refs[0].filePath);
                setActiveIndex(0);
            }
        } catch (err) {
            setKeywordError(err.message);
        } finally {
            setLoadingKeyword(null);
        }
    };

    const clearKeywordSearch = () => {
        setSearchResultReferences(null);
        setSelectedKeyword(null);
        setKeywordError('');
        setActiveFilePath(references[0]?.filePath || codeFiles[0]?.filePath || '');
        setActiveIndex(0);
    };

    const ingestion = selectedNode?.code_ingestion;
    const status = ingestion?.status || 'not_ready';
    const detail = status === 'ready'
        ? `Parsed ${ingestion.blockCount || 0} code blocks, but no strong code match was found for this node.`
        : ingestion?.reason || 'Code evidence was not generated for this repo analysis.';

    const activeReference = visibleReferences[Math.min(activeIndex, Math.max(visibleReferences.length - 1, 0))] || visibleReferences[0] || null;
    const activeCodeFile = codeFiles.find(file => (file.filePath || file.path) === activeFilePath);
    const activeFileId = activeReference?.fileId || activeCodeFile?.fileId;
    const activeFile = activeFileId ? fullFiles[activeFileId] : null;
    const displayCode = showFullFile && activeFile?.content ? activeFile.content : activeReference?.snippet;
    const displayStartLine = showFullFile && activeFile?.content ? 1 : activeReference?.startLine;
    const anchorStartLine = activeReference?.anchorStartLine || activeReference?.startLine;
    const anchorEndLine = activeReference?.anchorEndLine || activeReference?.endLine;
    const fullFileHighlightRanges = showFullFile
        ? visibleReferences.map(reference => ({
            start: reference.anchorStartLine || reference.startLine,
            end: reference.anchorEndLine || reference.endLine,
        }))
        : [];
    const displayLabel = showFullFile && activeFile?.content
        ? 'Full file'
        : activeReference
            ? 'Implementation trace'
            : 'No node match';

    const loadFullFile = async () => {
        if (!activeFileId || fullFiles[activeFileId]) return;
        setLoadingFile(true);
        setFileError('');
        try {
            const requestUserId = userId || sessionStorage.getItem('questmap_uid') || 'anonymous';
            const response = await fetch(`${API_BASE}/repo/code/file/${activeFileId}?userId=${encodeURIComponent(requestUserId)}`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.details || data.error || 'Unable to load full file');
            setFullFiles(current => ({ ...current, [activeFileId]: data }));
        } catch (err) {
            setFileError(err.message);
        } finally {
            setLoadingFile(false);
        }
    };

    const handleToggleFullFile = async () => {
        const next = !showFullFile;
        setShowFullFile(next);
        if (next) await loadFullFile();
    };

    return (
        <div className="space-y-3">
            {/* Keywords filter pills section */}
            {selectedNode?.key_concepts?.length > 0 && (
                <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-3 flex flex-wrap items-center gap-1.5">
                    <span className="text-[9px] font-black uppercase tracking-widest text-gray-500">Filter by keyword:</span>
                    {selectedNode.key_concepts.map(kw => {
                        const isActive = selectedKeyword === kw;
                        const isLoading = loadingKeyword === kw;
                        return (
                            <button
                                key={kw}
                                type="button"
                                disabled={loadingKeyword !== null}
                                onClick={() => isActive ? clearKeywordSearch() : searchCodeByKeyword(kw)}
                                className={`rounded-md border px-2 py-0.5 text-[9px] font-bold transition flex items-center gap-1 ${
                                    isActive
                                        ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-300'
                                        : 'border-gray-700/50 bg-gray-800/40 text-gray-400 hover:border-gray-600 hover:text-gray-200'
                                }`}
                            >
                                {isLoading && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                                <span>{kw}</span>
                            </button>
                        );
                    })}
                    {selectedKeyword && (
                        <button
                            type="button"
                            onClick={clearKeywordSearch}
                            className="text-[9px] text-red-400 hover:text-red-300 underline font-bold"
                        >
                            Clear filter
                        </button>
                    )}
                </div>
            )}

            {keywordError && (
                <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[9px] text-red-300">
                    {keywordError}
                </p>
            )}

            {/* Tree and code flex wrapper */}
            <div 
                ref={containerRef} 
                className="flex flex-col lg:flex-row gap-3"
                style={{ '--tree-sidebar-width': `${treeWidth}px` }}
            >
                {tree.length > 0 && (
                    <>
                        <div className="code-tree-sidebar flex-shrink-0 max-h-[34rem] overflow-auto rounded-2xl border border-gray-700/40 bg-gray-950/40 p-2 custom-scrollbar">
                            <p className="mb-2 px-2 text-[9px] font-black uppercase tracking-widest text-gray-600">Code Tree</p>
                            {tree.map(node => (
                                <CodeTreeNode
                                    key={node.path}
                                    node={node}
                                    activeFilePath={activeFilePath}
                                    matchedFileScores={matchedFileScores}
                                    scoreRange={scoreRange}
                                    onSelectFile={(path) => {
                                        setActiveFilePath(path);
                                        setActiveIndex(0);
                                        setExpanded(true);
                                        setShowFullFile(false);
                                        setFileError('');
                                    }}
                                />
                            ))}
                        </div>
                        {/* Vertical resize handle */}
                        <div
                            role="separator"
                            onPointerDown={handleTreeResizeStart}
                            className="hidden lg:flex w-1.5 flex-shrink-0 cursor-col-resize items-center justify-center relative group"
                        >
                            <div className={`h-12 w-0.5 rounded-full transition-colors ${
                                isResizingTree 
                                    ? 'bg-blue-400' 
                                    : 'bg-gray-700 group-hover:bg-blue-400'
                            }`} />
                        </div>
                    </>
                )}

                {tree.length === 0 ? (
                    <div className="flex-1 min-w-0 rounded-2xl border border-gray-700/40 bg-gray-900/30 p-3">
                        <div className="flex items-center gap-2">
                            <Code className="h-4 w-4 text-gray-500" />
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Code Evidence</span>
                            <span className="rounded-full border border-gray-700/50 px-2 py-0.5 text-[9px] font-bold uppercase text-gray-500">
                                {status.replace(/_/g, ' ')}
                            </span>
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-gray-500">{detail}</p>
                    </div>
                ) : (
                    <div className="flex-1 min-w-0 rounded-2xl border border-gray-700/40 bg-gray-900/35 p-3">
                        <button
                            type="button"
                            onClick={() => setExpanded(value => !value)}
                            className="flex w-full items-center justify-between gap-3 text-left"
                        >
                            <span className="flex min-w-0 items-center gap-2">
                                <Code className="h-4 w-4 flex-shrink-0 text-emerald-400" />
                                <span className="truncate text-[10px] font-black uppercase tracking-widest text-gray-300">
                                    Code Evidence
                                </span>
                                {visibleReferences.length > 0 && (
                                    <span className="rounded-full border border-gray-700/50 px-2 py-0.5 text-[9px] font-bold text-gray-500">
                                        {visibleReferences.length}
                                    </span>
                                )}
                            </span>
                            {expanded ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
                        </button>

                        {expanded && (
                            <div className="mt-3 space-y-3">
                                {selectedKeyword && (
                                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[10px] leading-relaxed text-emerald-300">
                                        <span className="font-bold">Active Keyword Filter: </span>
                                        <span className="font-mono">"{selectedKeyword}"</span>
                                    </div>
                                )}

                                {visibleReferences.length === 0 ? (
                                    <>
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="truncate font-mono text-[10px] text-gray-300">
                                                    {activeFilePath}
                                                </p>
                                                <p className="mt-1 text-[10px] text-gray-500 italic">
                                                    No relevant snippet traces found for this node.
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={handleToggleFullFile}
                                                disabled={loadingFile || !activeFileId}
                                                className="flex-shrink-0 rounded-lg border border-gray-700/50 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-gray-400 transition hover:border-gray-600 hover:text-gray-200 disabled:opacity-50"
                                            >
                                                {loadingFile ? 'Loading' : showFullFile ? 'Hide Code' : 'Full File'}
                                            </button>
                                        </div>

                                        {fileError && (
                                            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[10px] text-red-300">
                                                {fileError}
                                            </p>
                                        )}

                                        <div className="overflow-hidden rounded-xl border border-gray-700/40 bg-gray-950/70">
                                            <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
                                                <span className="text-[9px] font-black uppercase tracking-widest text-gray-500">
                                                    {showFullFile ? 'Full file' : 'No node match'}
                                                </span>
                                                <span className="text-[9px] font-bold text-gray-600">{activeCodeFile?.language || 'text'}</span>
                                            </div>
                                            {showFullFile && displayCode ? (
                                                <CodeBlockWithHighlights
                                                    code={displayCode}
                                                    startLine={displayStartLine}
                                                    highlightStart={null}
                                                    highlightEnd={null}
                                                    highlightRanges={[]}
                                                    language={activeCodeFile?.language}
                                                />
                                            ) : (
                                                <pre className="code-viewer-pre overflow-auto p-3 text-[11px] leading-relaxed text-gray-300 custom-scrollbar">
                                                    <code>
                                                        {showFullFile && loadingFile 
                                                            ? 'Fetching code content from repository...' 
                                                            : 'Click the "Full File" button above to view the complete code content.'}
                                                    </code>
                                                </pre>
                                            )}
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="truncate font-mono text-[10px] text-gray-300">
                                                    {activeReference
                                                        ? `${activeReference.filePath}:${activeReference.startLine}-${activeReference.endLine}`
                                                        : activeFilePath}
                                                </p>
                                                {activeReference?.anchorStartLine && (
                                                    <p className="mt-1 text-[10px] font-bold text-emerald-400">
                                                        {showFullFile && visibleReferences.length > 1
                                                            ? `Snippet ${activeIndex + 1} of ${visibleReferences.length} (Relevant: ${activeReference.anchorStartLine}-${activeReference.anchorEndLine})`
                                                            : `Relevant lines: ${activeReference.anchorStartLine}-${activeReference.anchorEndLine}`}
                                                        {activeReference.anchorSymbolName ? ` · ${activeReference.anchorSymbolName}` : ''}
                                                    </p>
                                                )}
                                                {activeReference?.summary && (
                                                    <p className="mt-1 text-[11px] leading-relaxed text-gray-500">{activeReference.summary}</p>
                                                )}
                                                {activeReference?.reason && (
                                                    <p className="mt-1 text-[11px] leading-relaxed text-gray-500">{activeReference.reason}</p>
                                                )}
                                            </div>
                                            {showFullFile && visibleReferences.length > 1 && (
                                                <div className="flex items-center gap-1.5 bg-gray-800/40 border border-gray-700/30 rounded-lg p-1 flex-shrink-0">
                                                    <button
                                                        type="button"
                                                        disabled={activeIndex === 0}
                                                        onClick={() => setActiveIndex(prev => Math.max(0, prev - 1))}
                                                        className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:hover:bg-gray-700 text-[9px] font-black uppercase tracking-widest text-white transition-all"
                                                    >
                                                        Prev
                                                    </button>
                                                    <span className="text-[9px] font-bold text-gray-400 px-1 font-mono">
                                                        {activeIndex + 1}/{visibleReferences.length}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        disabled={activeIndex === visibleReferences.length - 1}
                                                        onClick={() => setActiveIndex(prev => Math.min(visibleReferences.length - 1, prev + 1))}
                                                        className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:hover:bg-gray-700 text-[9px] font-black uppercase tracking-widest text-white transition-all"
                                                    >
                                                        Next
                                                    </button>
                                                </div>
                                            )}
                                            {visibleReferences.length === 1 && (
                                                <button
                                                    type="button"
                                                    onClick={handleToggleFullFile}
                                                    disabled={loadingFile || !activeFileId}
                                                    className="flex-shrink-0 rounded-lg border border-gray-700/50 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-gray-400 transition hover:border-gray-600 hover:text-gray-200 disabled:opacity-50"
                                                >
                                                    {loadingFile ? 'Loading' : showFullFile ? 'Snippet' : 'Full File'}
                                                </button>
                                            )}
                                        </div>

                                        {fileError && (
                                            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[10px] text-red-300">
                                                {fileError}
                                            </p>
                                        )}

                                        <div className="overflow-hidden rounded-xl border border-gray-700/40 bg-gray-950/70">
                                            <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
                                                <span className="text-[9px] font-black uppercase tracking-widest text-gray-500">
                                                    {displayLabel}
                                                    {showFullFile && visibleReferences.length > 1
                                                        ? ` (${visibleReferences.length} snippets)`
                                                        : activeReference
                                                            ? ` ${formatCodeConfidence(activeReference.score)}`
                                                            : ''}
                                                </span>
                                                <span className="text-[9px] font-bold text-gray-600">{activeReference?.language || activeCodeFile?.language || 'text'}</span>
                                            </div>
                                            {displayCode ? (
                                                <CodeBlockWithHighlights
                                                    code={displayCode}
                                                    startLine={displayStartLine}
                                                    highlightStart={anchorStartLine}
                                                    highlightEnd={anchorEndLine}
                                                    highlightRanges={fullFileHighlightRanges}
                                                    focusStartLine={anchorStartLine}
                                                    language={activeReference?.language || activeCodeFile?.language}
                                                />
                                            ) : (
                                                <pre className="code-viewer-pre overflow-auto p-3 text-[11px] leading-relaxed text-gray-300 custom-scrollbar">
                                                    <code>No matched code snippet for this file.</code>
                                                </pre>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// ─── Main Panel ─────────────────────────────────────────────────────────────

const ResourcePanel = ({ resourceData, loading, selectedNode, userId }) => {
    const isRepo = selectedNode?.repoConcept;
    const tabs = isRepo
        ? [
            { id: 'code', label: 'Code', icon: Code },
            { id: 'youtube', label: 'YouTube', icon: Youtube },
            { id: 'articles', label: 'Articles', icon: BookOpen },
          ]
        : [
            { id: 'youtube', label: 'YouTube', icon: Youtube },
            { id: 'articles', label: 'Articles', icon: BookOpen },
            { id: 'books', label: 'Books', icon: Library },
            { id: 'code', label: 'Code', icon: Code },
          ];

    const [activeResourceTab, setActiveResourceTab] = React.useState(isRepo ? 'code' : 'youtube');

    React.useEffect(() => {
        if (selectedNode) {
            setActiveResourceTab(selectedNode.repoConcept ? 'code' : 'youtube');
        }
    }, [selectedNode?.id, selectedNode?.repoConcept]);

    if (loading) {
        return (
            <div className="space-y-4">
                {selectedNode && (
                    <div className="flex items-center gap-2 mb-6 animate-pulse">
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                            Loading Resources for: {selectedNode.label}
                        </span>
                    </div>
                )}
                {[1, 2, 3, 4].map(i => (
                    <div key={i} className="animate-pulse bg-gray-800/40 rounded-2xl h-28 border border-gray-700/30" />
                ))}
            </div>
        );
    }

    if (!resourceData) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                <Youtube className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm italic">Click a node to discover curated learning resources</p>
            </div>
        );
    }

    const resourceCounts = {
        youtube: (resourceData.subscription_videos?.length || 0) + (resourceData.youtube_videos?.length || 0),
        articles: resourceData.articles?.length || 0,
        books: resourceData.books?.length || 0,
        code: selectedNode?.repoConcept ? (selectedNode.code_references?.length || 0) : 0,
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex-shrink-0 space-y-4 pb-4">
                {selectedNode && (
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                            Resources for: {selectedNode.label}
                        </span>
                    </div>
                )}

                <div className={`grid ${isRepo ? 'grid-cols-3' : 'grid-cols-4'} gap-2 rounded-2xl border border-gray-700/40 bg-gray-900/40 p-1.5 resource-subtabs`}>
                    {tabs.map(tab => {
                        const Icon = tab.icon;
                        const isActive = activeResourceTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => setActiveResourceTab(tab.id)}
                                className={`h-10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 ${
                                    isActive
                                        ? 'bg-white/10 text-white shadow-sm'
                                        : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                                }`}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                <span>{tab.label}</span>
                                <span className="text-[9px] opacity-60">({resourceCounts[tab.id]})</span>
                            </button>
                        );
                    })}
                </div>

                <ResourceGroundingSummary coverage={resourceData.source_coverage} />
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1 custom-scrollbar">
                {activeResourceTab === 'youtube' && (
                    <>
                    {resourceData.subscription_videos?.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <Youtube className="w-4 h-4 text-red-500" />
                                <h3 className="resource-section-title font-bold text-sm">From Your Subscriptions</h3>
                                <span className="text-gray-600 text-[10px]">({resourceData.subscription_videos.length})</span>
                            </div>
                            <QueryCaption query={resourceData.subscription_videos[0]?.search_query} />
                            <div className="space-y-3">
                                {resourceData.subscription_videos.map((v, i) => (
                                    <YouTubeCard key={v.id || i} video={v} index={i} />
                                ))}
                            </div>
                        </div>
                    )}

                    {resourceData.youtube_videos?.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <Youtube className="w-4 h-4 text-red-500" />
                                <h3 className="resource-section-title font-bold text-sm">YouTube Search Results</h3>
                                <span className="text-gray-600 text-[10px]">({resourceData.youtube_videos.length})</span>
                            </div>
                            <QueryCaption query={resourceData.youtube_videos[0]?.search_query} />
                            <div className="space-y-3">
                                {resourceData.youtube_videos.map((v, i) => (
                                    <YouTubeCard key={v.id || i} video={v} index={i} />
                                ))}
                            </div>
                        </div>
                    )}

                    {resourceCounts.youtube === 0 && (
                        <ResourceEmptyState icon={Youtube} label="No YouTube videos available for this node yet" />
                    )}
                    <ResourceLearningTasks tasks={resourceData.learning_tasks || []} activeTab={activeResourceTab} />
                    </>
                )}

                {activeResourceTab === 'articles' && (
                    <>
                    {resourceData.articles?.length > 0 ? (
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <BookOpen className="w-4 h-4 text-blue-400" />
                                <h3 className="resource-section-title font-bold text-sm">Articles & Documentation</h3>
                                <span className="text-gray-600 text-[10px]">({resourceData.articles.length})</span>
                            </div>
                            <div className="space-y-3">
                                {resourceData.articles.map((a, i) => (
                                    <ArticleCard key={a.id || i} article={a} index={i} />
                                ))}
                            </div>
                        </div>
                    ) : (
                        <ResourceEmptyState icon={BookOpen} label="No articles available for this node yet" />
                    )}
                    <ResourceLearningTasks tasks={resourceData.learning_tasks || []} activeTab={activeResourceTab} />
                    </>
                )}

                {activeResourceTab === 'books' && (
                    <>
                    {resourceData.books?.length > 0 ? (
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <Library className="w-4 h-4 text-purple-400" />
                                <h3 className="resource-section-title font-bold text-sm">Recommended Books</h3>
                                <span className="text-gray-600 text-[10px]">({resourceData.books.length})</span>
                            </div>
                            <div className="space-y-3">
                                {resourceData.books.map((b, i) => (
                                    <BookCard key={i} book={b} index={i} />
                                ))}
                            </div>
                        </div>
                    ) : (
                        <ResourceEmptyState icon={Library} label="No books available for this node yet" />
                    )}
                    <ResourceLearningTasks tasks={resourceData.learning_tasks || []} activeTab={activeResourceTab} />
                    </>
                )}

                {activeResourceTab === 'code' && (
                    selectedNode?.repoConcept ? (
                        <CodeEvidencePanel key={selectedNode.id || selectedNode.label} selectedNode={selectedNode} userId={userId} />
                    ) : (
                        <ResourceEmptyState icon={Code} label="Code evidence is available for GitHub repo learning nodes" />
                    )
                )}
            </div>
        </div>
    );
};

export default ResourcePanel;
