import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, X, CheckCircle, AlertCircle, Loader2, Trash2 } from 'lucide-react';
import { API_BASE } from '../config/api';

const FILE_ICONS = {
    'application/pdf': '📄',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📝',
    'text/plain': '📃',
};

const DocumentUpload = ({ userId, documents = [], onDocumentsChange }) => {
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState('');
    const [error, setError] = useState(null);
    const [dragOver, setDragOver] = useState(false);
    const [category, setCategory] = useState('source');
    const fileInputRef = useRef(null);

    const handleUpload = useCallback(async (file) => {
        if (!file) return;
        if (!userId) {
            setError('Please log in to upload documents.');
            return;
        }

        const maxSize = 10 * 1024 * 1024; // 10MB
        if (file.size > maxSize) {
            setError('File too large. Maximum size is 10MB.');
            return;
        }

        setUploading(true);
        setError(null);
        setUploadProgress('Uploading...');

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('userId', userId);
            formData.append('category', category);

            setUploadProgress('Processing document...');

            const res = await fetch(`${API_BASE}/upload-document`, {
                method: 'POST',
                body: formData,
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Upload failed');
            }

            const data = await res.json();
            setUploadProgress(`Done! ${data.document.chunkCount} sections indexed.`);

            // Refresh documents list
            if (onDocumentsChange) onDocumentsChange();

            // Clear progress after a moment
            setTimeout(() => setUploadProgress(''), 3000);
        } catch (err) {
            setError(err.message);
            setUploadProgress('');
        } finally {
            setUploading(false);
        }
    }, [userId, category, onDocumentsChange]);

    const handleDelete = async (docId) => {
        try {
            await fetch(`${API_BASE}/document/${docId}`, { method: 'DELETE' });
            if (onDocumentsChange) onDocumentsChange();
        } catch {
            setError('Failed to delete document.');
        }
    };

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleUpload(file);
    }, [handleUpload]);

    const handleDragOver = (e) => { e.preventDefault(); setDragOver(true); };
    const handleDragLeave = () => setDragOver(false);

    return (
        <div className="space-y-4">
            {/* Category Toggle */}
            <div className="flex bg-gray-800/40 rounded-xl p-1 border border-gray-700/50">
                <button
                    onClick={() => setCategory('source')}
                    className={`flex-1 py-1.5 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all ${
                        category === 'source' ? 'bg-blue-500/20 text-blue-400 shadow-sm' : 'text-gray-500 hover:text-gray-400'
                    }`}
                >
                    Source Material (Textbook)
                </button>
                <button
                    onClick={() => setCategory('context')}
                    className={`flex-1 py-1.5 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all ${
                        category === 'context' ? 'bg-purple-500/20 text-purple-400 shadow-sm' : 'text-gray-500 hover:text-gray-400'
                    }`}
                >
                    Personal Context (Notes/Exams)
                </button>
            </div>

            {/* Drop zone */}
            <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => !uploading && fileInputRef.current?.click()}
                className={`
                    relative border-2 border-dashed rounded-xl p-5 text-center cursor-pointer
                    transition-all duration-300
                    ${dragOver
                        ? 'border-purple-500 bg-purple-500/10 scale-[1.02]'
                        : 'border-gray-700/40 hover:border-gray-600/60 hover:bg-gray-800/30'
                    }
                    ${uploading ? 'pointer-events-none opacity-60' : ''}
                `}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx,.txt"
                    onChange={(e) => handleUpload(e.target.files[0])}
                    className="hidden"
                />

                {uploading ? (
                    <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
                        <p className="text-xs text-purple-400">{uploadProgress}</p>
                    </div>
                ) : uploadProgress ? (
                    <div className="flex flex-col items-center gap-2">
                        <CheckCircle className="w-6 h-6 text-emerald-400" />
                        <p className="text-xs text-emerald-400">{uploadProgress}</p>
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-2">
                        <Upload className="w-6 h-6 text-gray-500" />
                        <p className="text-xs text-gray-400">
                            Drop a file here or <span className="text-purple-400 font-medium">browse</span>
                        </p>
                        <p className="text-[10px] text-gray-600">PDF, DOCX, or TXT • Max 10MB</p>
                    </div>
                )}
            </div>

            {/* Error */}
            <AnimatePresence>
                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: -5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -5 }}
                        className="flex items-center gap-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20"
                    >
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                        <p className="text-[10px] text-red-400 flex-1">{error}</p>
                        <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">
                            <X className="w-3 h-3" />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Documents list */}
            {documents.length > 0 && (
                <div className="space-y-1.5">
                    <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Uploaded Documents</p>
                    {documents.map((doc) => (
                        <div
                            key={doc._id}
                            className="flex items-center gap-2.5 p-2 rounded-lg bg-gray-800/30 border border-gray-700/20 group"
                        >
                            <span className="text-sm">{FILE_ICONS[doc.mimetype] || '📄'}</span>
                            <div className="flex-1 min-w-0">
                                <p className="text-[11px] text-gray-300 truncate">{doc.filename}</p>
                                <p className="text-[9px] text-gray-600">
                                    <span className={doc.category === 'context' ? 'text-purple-400' : 'text-blue-400'}>{doc.category === 'context' ? 'Context' : 'Source'}</span> • {doc.chunkCount} chunks
                                    {doc.status === 'processing' && ' • Processing...'}
                                </p>
                            </div>
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                doc.status === 'ready' ? 'bg-emerald-500' :
                                doc.status === 'processing' ? 'bg-yellow-500 animate-pulse' :
                                'bg-red-500'
                            }`} />
                            <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(doc._id); }}
                                className="opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                <Trash2 className="w-3 h-3 text-gray-600 hover:text-red-400" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default DocumentUpload;
