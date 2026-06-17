import React from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Compass, LogIn } from 'lucide-react';
import Hero from './components/Hero';

function App() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-blue-500/30 overflow-x-hidden">
      {/* Background Atmosphere */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/5 rounded-full blur-[120px]" />
      </div>

      {/* Nav */}
      <nav className="flex items-center justify-between px-12 py-8 max-w-7xl mx-auto relative z-20">
        <div className="flex items-center gap-4 group cursor-pointer" onClick={() => navigate('/')}>
          <div className="bg-blue-600 p-2.5 rounded-xl shadow-2xl shadow-blue-600/40 group-hover:scale-110 transition-all duration-300">
            <Compass className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-black tracking-tighter uppercase font-outfit">QuestMap</span>
        </div>

        <div className="flex items-center gap-8">
          <button
            onClick={() => navigate('/profile')}
            className="bg-white/5 border border-white/10 px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] hover:bg-white/10 transition-all"
          >
            Start Quest
          </button>
        </div>
      </nav>

      <Hero />

      {/* Grid Overlay Decoration */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:100px_100px]" />
    </div>
  );
}

export default App;
