import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'

const Home = lazy(() => import('./pages/Home.jsx'));
const App = lazy(() => import('./App.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const LevelQuiz = lazy(() => import('./pages/LevelQuiz.jsx'));

const RouteFallback = () => (
    <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-[10px] font-black uppercase tracking-[0.4em] text-white/40">Loading QuestMap</div>
    </div>
);

const rootElement = document.getElementById('root');

if (!rootElement) {
    console.error("CRITICAL: #root element not found in HTML!");
}

try {
    const root = createRoot(rootElement);
    root.render(
        <StrictMode>
            <BrowserRouter>
                <Suspense fallback={<RouteFallback />}>
                    <Routes>
                        <Route path="/" element={<Profile />} />
                        <Route path="/overview" element={<App />} />
                        <Route path="/login" element={<Login />} />
                        <Route path="/profile" element={<Profile />} />
                        <Route path="/dashboard" element={<Dashboard />} />
                        <Route path="/quiz" element={<LevelQuiz />} />
                    </Routes>
                </Suspense>
            </BrowserRouter>
        </StrictMode>
    );
} catch (error) {
    console.error("Critical React Mounting Error:", error);
    rootElement.innerHTML = `
        <div style="background: #000000; color: #f87171; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif; padding: 20px; text-align: center;">
            <h1 style="font-size: 24px;">QuestMap failed to start</h1>
            <pre style="background: #1f2937; padding: 15px; border-radius: 8px; margin-top: 20px; white-space: pre-wrap; font-size: 14px;">\${error.message}</pre>
        </div>
    `;
}
