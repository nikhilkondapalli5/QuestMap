import React, { useState, useEffect } from 'react';
import { Globe, Plus, X } from 'lucide-react';
import { API_BASE } from '../config/api';

const DomainPreferences = ({ userId }) => {
    const [preferred, setPreferred] = useState([]);
    const [excluded, setExcluded] = useState([]);
    const [prefInput, setPrefInput] = useState('');
    const [exclInput, setExclInput] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (!userId) return;
        const fetchPrefs = async () => {
            try {
                const res = await fetch(`${API_BASE}/user-preferences/${userId}`);
                if (res.ok) {
                    const data = await res.json();
                    setPreferred(data.preferredDomains || []);
                    setExcluded(data.deprioritizedDomains || []);
                }
            } catch (err) {
                console.error("Failed to fetch preferences:", err);
            }
        };
        fetchPrefs();
    }, [userId]);

    const savePrefs = async (newPref, newExcl) => {
        if (!userId) return;
        setIsSaving(true);
        try {
            await fetch(`${API_BASE}/user-preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId,
                    preferredDomains: newPref,
                    deprioritizedDomains: newExcl
                })
            });
        } catch (err) {
            console.error("Failed to save preferences:", err);
        }
        setIsSaving(false);
    };

    const addPreferred = (e) => {
        if (e.key === 'Enter' || e.type === 'click') {
            e.preventDefault();
            if (prefInput.trim() && !preferred.includes(prefInput.trim())) {
                const newPref = [...preferred, prefInput.trim()];
                setPreferred(newPref);
                setPrefInput('');
                savePrefs(newPref, excluded);
            }
        }
    };

    const removePreferred = (domain) => {
        const newPref = preferred.filter(d => d !== domain);
        setPreferred(newPref);
        savePrefs(newPref, excluded);
    };

    const addExcluded = (e) => {
        if (e.key === 'Enter' || e.type === 'click') {
            e.preventDefault();
            if (exclInput.trim() && !excluded.includes(exclInput.trim())) {
                const newExcl = [...excluded, exclInput.trim()];
                setExcluded(newExcl);
                setExclInput('');
                savePrefs(preferred, newExcl);
            }
        }
    };

    const removeExcluded = (domain) => {
        const newExcl = excluded.filter(d => d !== domain);
        setExcluded(newExcl);
        savePrefs(preferred, newExcl);
    };

    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <label className="text-[10px] font-black text-blue-400 uppercase tracking-widest flex items-center gap-2">
                    <Globe className="w-3 h-3" />
                    Prioritize Articles From:
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {preferred.map(d => (
                        <div key={d} className="flex items-center gap-1 bg-blue-500/20 text-blue-300 text-xs px-3 py-1.5 rounded-full border border-blue-500/30">
                            {d}
                            <X className="w-3 h-3 cursor-pointer hover:text-white" onClick={() => removePreferred(d)} />
                        </div>
                    ))}
                </div>
                <div className="relative flex items-center">
                    <input 
                        type="text" 
                        value={prefInput}
                        onChange={e => setPrefInput(e.target.value)}
                        onKeyDown={addPreferred}
                        placeholder="e.g. geeksforgeeks, ibm.com"
                        className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 pr-12"
                    />
                    <button onClick={addPreferred} className="absolute right-2 p-1.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/40 transition-colors">
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="space-y-3">
                <label className="text-[10px] font-black text-red-400 uppercase tracking-widest flex items-center gap-2">
                    <Globe className="w-3 h-3" />
                    Exclude Articles From:
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {excluded.map(d => (
                        <div key={d} className="flex items-center gap-1 bg-red-500/20 text-red-300 text-xs px-3 py-1.5 rounded-full border border-red-500/30">
                            {d}
                            <X className="w-3 h-3 cursor-pointer hover:text-white" onClick={() => removeExcluded(d)} />
                        </div>
                    ))}
                </div>
                <div className="relative flex items-center">
                    <input 
                        type="text" 
                        value={exclInput}
                        onChange={e => setExclInput(e.target.value)}
                        onKeyDown={addExcluded}
                        placeholder="e.g. wikipedia.org"
                        className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-red-500/50 pr-12"
                    />
                    <button onClick={addExcluded} className="absolute right-2 p-1.5 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/40 transition-colors">
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
            </div>
            
            {isSaving && <div className="text-xs text-white/40 italic">Saving preferences...</div>}
        </div>
    );
};

export default DomainPreferences;
