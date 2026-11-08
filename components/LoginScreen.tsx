import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { getCachedBranding, loadBranding, Branding, companyInitials } from '../lib/branding';
import { CurrentUser } from '../types';
import { Mail, Lock, Loader2, AlertCircle } from 'lucide-react';

interface LoginScreenProps {
  onLogin: (user: CurrentUser) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [branding, setBranding] = useState<Branding>(getCachedBranding());

  useEffect(() => { loadBranding().then(setBranding).catch(() => {}); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // v5.3.24 (A5): el servidor ya dejó el token en cookie HttpOnly;
        // el frontend ya no guarda nada en localStorage.
        onLogin(data.user);
      } else {
        setError(data.error || 'Credenciales inválidas');
      }
    } catch (err) {
      setError('Error de conexión con el servidor');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="mb-8 text-center">
        {branding.logo_url ? (
          <img src={branding.logo_url} alt={branding.company_name} className="h-20 w-20 object-contain mx-auto mb-4 bg-white rounded-2xl shadow-lg p-2" />
        ) : (
          // v5.3.26 (B4): iniciales de la empresa en vez del icono fijo.
          <div className="inline-flex items-center justify-center w-20 h-20 bg-brand-600 rounded-2xl mb-4 shadow-lg">
            <span className="text-white font-bold text-3xl">{companyInitials(branding.company_name)}</span>
          </div>
        )}
        <h1 className="text-3xl font-bold text-slate-800">{branding.company_name}</h1>
        <p className="text-slate-500 mt-2">{branding.tagline}</p>
      </div>

      <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-slate-100">
        <h2 className="text-xl font-bold text-slate-800 mb-6 text-center">Iniciar Sesión</h2>
        
        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg flex items-center gap-2 border border-red-100">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Correo Electrónico</label>
            <div className="relative">
              <Mail className="absolute left-3 top-3 w-5 h-5 text-slate-400" />
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
                placeholder="usuario@empresa.com"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Contraseña</label>
            <div className="relative">
              <Lock className="absolute left-3 top-3 w-5 h-5 text-slate-400" />
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
                placeholder="••••••••"
              />
            </div>
          </div>

          <button 
            type="submit" 
            disabled={loading}
            className="w-full bg-brand-600 text-white font-bold py-3 rounded-xl hover:bg-brand-700 transition-colors shadow-md hover:shadow-lg disabled:opacity-70 flex justify-center items-center gap-2"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Ingresar al Sistema'}
          </button>
        </form>

        <div className="mt-6 text-center pt-6 border-t border-slate-100">
          <p className="text-xs text-slate-400">
            © {new Date().getFullYear()} {branding.company_name}
          </p>
        </div>
      </div>
    </div>
  );
};