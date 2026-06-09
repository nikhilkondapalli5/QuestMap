import React from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { Compass, Mail, Lock, ArrowRight } from 'lucide-react';

const Login = () => {
    const navigate = useNavigate();

    const handleGoogleLogin = async () => {
        try {
            const result = await signInWithPopup(auth, googleProvider);
            if (result.user) {
                // Extract the YouTube-scoped OAuth access token and store it for
                // the session so Dashboard can pass it to the backend.
                const credential = GoogleAuthProvider.credentialFromResult(result);
                if (credential?.accessToken) {
                    sessionStorage.setItem('yt_access_token', credential.accessToken);
                }
                navigate('/profile');
            }
        } catch (error) {
            console.error("Login failed:", error);
            if (error.code === 'auth/popup-closed-by-user') return;
            alert(`Login failed: ${error.message}`);
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-6">
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="max-w-md w-full bg-gray-800 rounded-3xl p-8 border border-gray-700 shadow-2xl"
            >
                <div className="text-center mb-8">
                    <div className="bg-blue-600 w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4">
                        <Compass className="w-8 h-8 text-white" />
                    </div>
                    <h1 className="text-3xl font-bold">Welcome Back</h1>
                    <p className="text-gray-400 mt-2">Log in to continue your quest</p>
                </div>

                <div className="space-y-4">
                    <div className="relative">
                        <Mail className="absolute left-3 top-3.5 w-5 h-5 text-gray-500" />
                        <input
                            type="email"
                            placeholder="Email address (Demo)"
                            className="w-full bg-gray-900 border border-gray-700 rounded-xl py-3 pl-10 pr-4 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            disabled
                        />
                    </div>
                    <div className="relative">
                        <Lock className="absolute left-3 top-3.5 w-5 h-5 text-gray-500" />
                        <input
                            type="password"
                            placeholder="Password (Demo)"
                            className="w-full bg-gray-900 border border-gray-700 rounded-xl py-3 pl-10 pr-4 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            disabled
                        />
                    </div>

                    <button className="w-full bg-gray-700 text-gray-400 font-bold py-3 rounded-xl cursor-not-allowed">
                        Sign In with Email (Coming Soon)
                    </button>

                    <div className="relative py-4">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-gray-700"></div>
                        </div>
                        <div className="relative flex justify-center text-sm">
                            <span className="px-2 bg-gray-800 text-gray-500">Or continue with</span>
                        </div>
                    </div>

                    <button
                        onClick={handleGoogleLogin}
                        className="w-full bg-white text-gray-900 font-bold py-3 rounded-xl hover:bg-gray-100 transition-all flex items-center justify-center gap-2"
                    >
                        <img src="https://www.google.com/favicon.ico" alt="Google" className="w-4 h-4" />
                        Sign in with Google
                    </button>
                </div>

                <p className="text-center text-gray-500 mt-8 text-sm">
                    Don't have an account? <span onClick={() => navigate('/profile')} className="text-blue-400 cursor-pointer hover:underline">Start a quest</span>
                </p>
            </motion.div>
        </div>
    );
};

export default Login;
