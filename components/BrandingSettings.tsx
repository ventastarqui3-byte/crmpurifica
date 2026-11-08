// Personalización / marca blanca (solo administradores).
// Cambia nombre, eslogan, colores y logo de la empresa sin tocar código:
// para revender el CRM a otra empresa basta con cambiar esto en Ajustes.
import React, { useState, useEffect, useRef } from 'react';
import { Palette, Upload, Save, Loader2, CheckCircle2, AlertCircle, Image as ImageIcon } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { isSafeImageSrc } from '../lib/safeUrl';
import { getCachedBranding, loadBranding, applyBranding, Branding } from '../lib/branding';

export const BrandingSettings: React.FC = () => {
  const [form, setForm] = useState<Branding>(getCachedBranding());
  const [logoPreview, setLogoPreview] = useState<string>(form.logo_url || '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadBranding().then((b) => { setForm(b); setLogoPreview(b.logo_url || ''); });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await apiFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({
          company_name: form.company_name,
          tagline: form.tagline,
          primary_color: form.primary_color,
          secondary_color: form.secondary_color,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo guardar');
      applyBranding({ ...form, logo_url: logoPreview });
      setMessage('Personalización guardada y aplicada.');
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleLogo = async (file: File) => {
    setUploading(true);
    setMessage('');
    try {
      const fd = new FormData();
      fd.append('logo', file);
      const res = await apiFetch('/api/settings/logo', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo subir el logo');
      setLogoPreview(data.logo_url);
      setForm((f) => ({ ...f, logo_url: data.logo_url }));
      applyBranding({ ...form, logo_url: data.logo_url });
      setMessage('Logo subido. Recuerda pulsar Guardar para aplicar los demás cambios.');
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Palette className="w-6 h-6 text-brand-600" /> Personalización
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Nombre, logo y colores de la empresa. Se aplican en el inicio de sesión, el menú y el
          resto del sistema. Para vender el CRM a otra empresa, cambia esto y nada más: cada
          cliente tiene su propia instalación y su propia base de datos.
        </p>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-5">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Nombre de la empresa</label>
          <input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })}
            className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Eslogan</label>
          <input value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })}
            className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Color principal</label>
            <div className="flex gap-2 items-center">
              <input type="color" value={form.primary_color} onChange={(e) => setForm({ ...form, primary_color: e.target.value })}
                className="w-12 h-10 border border-slate-300 rounded-lg cursor-pointer" />
              <input value={form.primary_color} onChange={(e) => setForm({ ...form, primary_color: e.target.value })}
                className="flex-1 border border-slate-300 rounded-lg p-2.5 outline-none font-mono text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Color secundario</label>
            <div className="flex gap-2 items-center">
              <input type="color" value={form.secondary_color} onChange={(e) => setForm({ ...form, secondary_color: e.target.value })}
                className="w-12 h-10 border border-slate-300 rounded-lg cursor-pointer" />
              <input value={form.secondary_color} onChange={(e) => setForm({ ...form, secondary_color: e.target.value })}
                className="flex-1 border border-slate-300 rounded-lg p-2.5 outline-none font-mono text-sm" />
            </div>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Logo (PNG o JPG, máx. 2 MB)</label>
          <div className="flex items-center gap-4">
            {/* v5.3.25 (M13): el logo solo se previsualiza si la URL es segura. */}
            {logoPreview && isSafeImageSrc(logoPreview) ? (
              <img src={logoPreview} alt="Logo" className="h-16 w-16 object-contain bg-slate-50 border border-slate-200 rounded-xl p-1" />
            ) : (
              <div className="h-16 w-16 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-xl text-slate-400">
                <ImageIcon className="w-6 h-6" />
              </div>
            )}
            <div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLogo(f); e.target.value = ''; }} />
              <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()}
                className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? 'Subiendo…' : 'Subir logo'}
              </button>
            </div>
          </div>
        </div>

        {message && (
          <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${message.startsWith('Error') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
            {message.startsWith('Error') ? <AlertCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />} {message}
          </div>
        )}

        <button type="button" onClick={handleSave} disabled={saving}
          className="w-full bg-brand-600 text-white font-bold py-3 rounded-xl hover:bg-brand-700 disabled:opacity-60 flex justify-center items-center gap-2">
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          Guardar personalización
        </button>
      </div>
    </div>
  );
};
