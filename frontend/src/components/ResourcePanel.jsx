import React from 'react';
import { motion } from 'framer-motion';
import { Youtube, BookOpen, Library, Clock, ExternalLink, Search, Play } from 'lucide-react';

const RESOURCE_TABS = [
    { id: 'youtube', label: 'YouTube', icon: Youtube },
    { id: 'articles', label: 'Articles', icon: BookOpen },
    { id: 'books', label: 'Books', icon: Library },
];

// Helper: open URL in new tab without affecting current page state
const openLink = (url, e) => {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    window.open(url, '_blank', 'noopener,noreferrer');
};

// ─── YouTube Video Card ─────────────────────────────────────────────────────

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
                    <p className="text-white text-xs font-semibold truncate flex-1">{video.title}</p>
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
                    <p className="text-white text-xs font-semibold truncate group-hover:text-red-300 transition-colors">
                        {video.title}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <p className="text-gray-500 text-[10px]">{video.channel || video.suggested_channel}</p>
                        {isApiSearchVideo && video.from_subscription && (
                            <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-gray-700/50 text-gray-300 border border-gray-600/40">
                                Subscribed channel
                            </span>
                        )}
                    </div>
                    {isApiSearchVideo && videoDescription && (
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
            {!isApiSearchVideo && (video.suggested_section || video.snippet_timestamp) && (
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
                    <p className="text-white text-xs font-semibold group-hover:text-blue-300 transition-colors truncate" title={article.title}>
                        {article.title}
                    </p>
                    <p className="text-gray-500 text-[10px]">{article.source}</p>
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
                    <p className="text-white text-xs font-semibold group-hover:text-purple-300 transition-colors">
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

// ─── Main Panel ─────────────────────────────────────────────────────────────

const ResourcePanel = ({ resourceData, loading, selectedNode }) => {
    const [activeResourceTab, setActiveResourceTab] = React.useState('youtube');

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
    };

    return (
        <div className="space-y-5 overflow-y-auto max-h-[calc(100vh-320px)] pr-1 custom-scrollbar">
            {selectedNode && (
                <div className="flex items-center gap-2 mb-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                        Resources for: {selectedNode.label}
                    </span>
                </div>
            )}

            <div className="grid grid-cols-3 gap-2 rounded-2xl border border-gray-700/40 bg-gray-900/40 p-1.5 resource-subtabs">
                {RESOURCE_TABS.map(tab => {
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

            {activeResourceTab === 'youtube' && (
                <>
                    {resourceData.subscription_videos?.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <Youtube className="w-4 h-4 text-red-500" />
                                <h3 className="text-white font-bold text-sm">From Your Subscriptions</h3>
                                <span className="text-gray-600 text-[10px]">({resourceData.subscription_videos.length})</span>
                            </div>
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
                                <h3 className="text-white font-bold text-sm">YouTube Search Results</h3>
                                <span className="text-gray-600 text-[10px]">({resourceData.youtube_videos.length})</span>
                            </div>
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
                </>
            )}

            {activeResourceTab === 'articles' && (
                <>
                    {resourceData.articles?.length > 0 ? (
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <BookOpen className="w-4 h-4 text-blue-400" />
                                <h3 className="text-white font-bold text-sm">Articles & Documentation</h3>
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
                </>
            )}

            {activeResourceTab === 'books' && (
                <>
                    {resourceData.books?.length > 0 ? (
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <Library className="w-4 h-4 text-purple-400" />
                                <h3 className="text-white font-bold text-sm">Recommended Books</h3>
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
                </>
            )}
        </div>
    );
};

export default ResourcePanel;
