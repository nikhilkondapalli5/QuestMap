import React, { useEffect, useState } from 'react';
import { GitBranch, Loader2, PlayCircle, BookOpen, Target, CheckCircle2, AlertCircle } from 'lucide-react';
import { API_BASE } from '../config/api';

const confidenceClass = {
    high: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    medium: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    low: 'border-gray-500/30 bg-gray-500/10 text-gray-300',
};

const EvidencePill = ({ evidence }) => (
    <span className="inline-flex max-w-full items-center rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-bold text-gray-400">
        <span className="truncate">{evidence?.type}: {evidence?.value}</span>
    </span>
);

const RepoLearningPanel = ({ userId, skillLevel, initialAnalysis, onConceptSelect }) => {
    const [repoUrl, setRepoUrl] = useState('');
    const [analysisResult, setAnalysisResult] = useState(initialAnalysis || null);
    const [selectedConceptId, setSelectedConceptId] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const evidenceById = new Map((analysisResult?.evidence || []).map(item => [item.id, item]));
    const concepts = analysisResult?.analysis?.concepts || [];
    const learningPath = analysisResult?.analysis?.learning_path || [];
    const selectedConcept = concepts.find(concept => concept.id === selectedConceptId) || concepts[0] || null;

    useEffect(() => {
        if (!initialAnalysis) return;
        setAnalysisResult(initialAnalysis);
        setRepoUrl(initialAnalysis.repo?.url || '');
        setSelectedConceptId(initialAnalysis.analysis?.learning_path?.[0]?.concept_id || initialAnalysis.analysis?.concepts?.[0]?.id || null);
    }, [initialAnalysis]);

    const analyzeRepo = async (event) => {
        event.preventDefault();
        if (!repoUrl.trim()) return;

        setLoading(true);
        setError('');
        try {
            const response = await fetch(`${API_BASE}/repo/analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId,
                    repoUrl: repoUrl.trim(),
                    skillLevel: skillLevel || 'beginner',
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.details || data.error || 'Failed to analyze repository');
            setAnalysisResult(data);
            setSelectedConceptId(data.analysis?.learning_path?.[0]?.concept_id || data.analysis?.concepts?.[0]?.id || null);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const activateConcept = (concept, targetTab) => {
        setSelectedConceptId(concept.id);
        onConceptSelect?.({
            ...concept,
            repoFullName: analysisResult?.repo?.fullName,
            repoUrl: analysisResult?.repo?.url,
        }, targetTab);
    };

    return (
        <div className="space-y-5 pb-4">
            <form onSubmit={analyzeRepo} className="space-y-3">
                <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-blue-400" />
                    <h3 className="text-sm font-black uppercase tracking-widest text-white">Repo Learning</h3>
                </div>
                <div className="flex gap-2">
                    <input
                        value={repoUrl}
                        onChange={event => setRepoUrl(event.target.value)}
                        placeholder="https://github.com/org/repo"
                        className="min-w-0 flex-1 rounded-xl border border-white/10 bg-gray-900/70 px-3 py-3 text-sm text-white outline-none transition focus:border-blue-400/60"
                    />
                    <button
                        type="submit"
                        disabled={loading || !repoUrl.trim()}
                        className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-500/15 text-blue-300 transition hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                        title="Analyze repository"
                    >
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                    </button>
                </div>
            </form>

            {error && (
                <div className="rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-xs leading-relaxed text-red-300">
                    <div className="flex items-start gap-2">
                        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        <span>{error}</span>
                    </div>
                </div>
            )}

            {!analysisResult && !loading && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                    <p className="text-sm leading-relaxed text-gray-400">
                        No repo analysis yet.
                    </p>
                </div>
            )}

            {analysisResult && (
                <>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">{analysisResult.repo?.fullName}</p>
                                <h4 className="mt-1 text-base font-bold text-white">{analysisResult.analysis?.repo_summary?.project_type}</h4>
                            </div>
                            <span className={`rounded-full border px-2 py-1 text-[10px] font-black uppercase ${confidenceClass[analysisResult.analysis?.repo_summary?.confidence] || confidenceClass.medium}`}>
                                {analysisResult.analysis?.repo_summary?.confidence || 'medium'}
                            </span>
                        </div>
                        <p className="mt-3 text-sm leading-relaxed text-gray-400">{analysisResult.analysis?.repo_summary?.plain_english}</p>
                        {analysisResult.analysis?.detected_stack?.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                {analysisResult.analysis.detected_stack.map(item => (
                                    <span key={item} className="rounded-md bg-white/5 px-2 py-1 text-[10px] font-bold text-gray-300">{item}</span>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            <Target className="h-4 w-4 text-emerald-400" />
                            <h4 className="text-xs font-black uppercase tracking-widest text-gray-400">Learning Path</h4>
                        </div>
                        {learningPath.map(step => {
                            const concept = concepts.find(item => item.id === step.concept_id);
                            const active = selectedConcept?.id === step.concept_id;
                            return (
                                <button
                                    key={`${step.order}-${step.concept_id}`}
                                    type="button"
                                    onClick={() => concept && setSelectedConceptId(concept.id)}
                                    className={`w-full rounded-2xl border p-4 text-left transition ${
                                        active
                                            ? 'border-blue-400/40 bg-blue-500/10'
                                            : 'border-white/10 bg-gray-900/35 hover:border-white/20 hover:bg-white/[0.04]'
                                    }`}
                                >
                                    <div className="flex gap-3">
                                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-white/10 text-xs font-black text-white">
                                            {step.order}
                                        </span>
                                        <div className="min-w-0">
                                            <h5 className="resource-card-title text-sm font-bold">{step.title}</h5>
                                            <p className="mt-1 text-xs leading-relaxed text-gray-400">{step.why_now}</p>
                                            {step.task && <p className="mt-2 text-xs leading-relaxed text-gray-500">{step.task}</p>}
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {selectedConcept && (
                        <div className="rounded-2xl border border-white/10 bg-gray-900/45 p-4">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">{selectedConcept.category}</p>
                                    <h4 className="resource-card-title mt-1 text-base font-bold">{selectedConcept.title}</h4>
                                </div>
                                <span className={`rounded-full border px-2 py-1 text-[10px] font-black uppercase ${confidenceClass[selectedConcept.confidence] || confidenceClass.medium}`}>
                                    {selectedConcept.confidence}
                                </span>
                            </div>
                            <p className="mt-3 text-sm leading-relaxed text-gray-400">{selectedConcept.why_relevant}</p>

                            {selectedConcept.learning_goals?.length > 0 && (
                                <div className="mt-4 space-y-2">
                                    {selectedConcept.learning_goals.map(goal => (
                                        <div key={goal} className="flex gap-2 text-xs text-gray-300">
                                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
                                            <span>{goal}</span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="mt-4 flex flex-wrap gap-2">
                                {(selectedConcept.evidence_ids || []).slice(0, 5).map(id => (
                                    <EvidencePill key={id} evidence={evidenceById.get(id)} />
                                ))}
                            </div>

                            <div className="mt-5 grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => activateConcept(selectedConcept, 'resources')}
                                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-3 text-xs font-black uppercase tracking-widest text-red-300 transition hover:bg-red-500/20"
                                >
                                    <BookOpen className="h-4 w-4" />
                                    Resources
                                </button>
                                <button
                                    type="button"
                                    onClick={() => activateConcept(selectedConcept, 'practice')}
                                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-3 text-xs font-black uppercase tracking-widest text-emerald-300 transition hover:bg-emerald-500/20"
                                >
                                    <Target className="h-4 w-4" />
                                    Practice
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default RepoLearningPanel;
