import React from 'react';
import { motion } from 'framer-motion';
import { FileText, User, Sparkles, AlertCircle } from 'lucide-react';

const KnowledgeContext = ({ context }) => {
    if (!context || (!context.source?.length && !context.personal?.length)) {
        return (
            <div className="py-20 flex flex-col items-center opacity-40">
                <AlertCircle className="w-10 h-10 mb-4" />
                <span className="text-[10px] font-black uppercase tracking-widest text-center max-w-[200px]">
                    No external context was retrieved for this specific map generation.
                </span>
            </div>
        );
    }

    return (
        <div className="space-y-8 pb-10">
            {/* Source Materials Section */}
            {context.source?.length > 0 && (
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center border border-blue-500/20">
                            <FileText className="w-4 h-4 text-blue-400" />
                        </div>
                        <h3 className="text-xs font-black uppercase tracking-widest text-blue-400">
                            Source Material Influence
                        </h3>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-relaxed italic">
                        The following snippets from your uploaded textbooks/syllabi were used to define the core structural nodes of this map.
                    </p>
                    <div className="space-y-3">
                        {context.source.map((item, i) => (
                            <motion.div 
                                key={`src-${i}`}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.1 }}
                                className="p-4 bg-white/5 border border-white/10 rounded-2xl group hover:border-blue-500/30 transition-colors"
                            >
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[9px] font-black uppercase text-blue-400/60 tracking-tighter truncate max-w-[200px]">
                                        {item.filename}
                                    </span>
                                </div>
                                <p className="text-[11px] text-gray-400 leading-relaxed font-mono">
                                    "{item.content}"
                                </p>
                            </motion.div>
                        ))}
                    </div>
                </div>
            )}

            {/* Personal Context Section */}
            {context.personal?.length > 0 && (
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-purple-500/10 flex items-center justify-center border border-purple-500/20">
                            <User className="w-4 h-4 text-purple-400" />
                        </div>
                        <h3 className="text-xs font-black uppercase tracking-widest text-purple-400">
                            Personal Context Overlay
                        </h3>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-relaxed italic">
                        These snippets from your notes or exam results were used to identify your weak spots and prioritize "Recommended Next" steps.
                    </p>
                    <div className="space-y-3">
                        {context.personal.map((item, i) => (
                            <motion.div 
                                key={`pers-${i}`}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: (context.source?.length || 0 + i) * 0.1 }}
                                className="p-4 bg-white/5 border border-white/10 rounded-2xl group hover:border-purple-500/30 transition-colors"
                            >
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[9px] font-black uppercase text-purple-400/60 tracking-tighter truncate max-w-[200px]">
                                        {item.filename}
                                    </span>
                                </div>
                                <p className="text-[11px] text-gray-400 leading-relaxed font-mono italic">
                                    "{item.content}"
                                </p>
                            </motion.div>
                        ))}
                    </div>
                </div>
            )}

            <div className="p-6 bg-emerald-500/5 border border-emerald-500/10 rounded-3xl flex items-start gap-4">
                <Sparkles className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-1" />
                <p className="text-xs text-emerald-400/80 leading-relaxed">
                    By combining your <b>Source Materials</b> with your <b>Notes</b>, QuestMap creates a bridge between general curriculum and your specific learning needs.
                </p>
            </div>
        </div>
    );
};

export default KnowledgeContext;
