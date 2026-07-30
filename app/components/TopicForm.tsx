'use client';

import { useState } from 'react';
import { validateTopicBasic, formatValidationMessage, isFatalValidation } from '@/lib/topicValidation';
import { toast } from './toast';

interface TopicFormProps {
  onSubmitted: () => void;
  onBulk: () => void;
}

export default function TopicForm({ onSubmitted, onBulk }: TopicFormProps) {
  const [title, setTitle] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showWebsiteField, setShowWebsiteField] = useState(false);

  async function submit() {
    const cleanTitle = title.trim();
    const cleanWebsite = website.trim();
    
    if (!cleanTitle || busy) return;
    
    // Basis validatie
    const validation = validateTopicBasic(cleanTitle, cleanWebsite);
    
    if (!validation.valid) {
      const message = formatValidationMessage(validation);
      setValidationError(message);
      
      // Bij een fatale fout stoppen we hier
      if (isFatalValidation(validation)) {
        return;
      }
    } else {
      setValidationError(null);
    }
    
    setBusy(true);
    try {
      const response = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          titles: [cleanTitle],
          website: cleanWebsite || undefined,
        }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        if (data.validationFailed) {
          let errorMsg = data.error;
          if (data.suggestion) {
            errorMsg += `\n\n💡 ${data.suggestion}`;
          }
          setValidationError(errorMsg);
          return;
        }
        throw new Error(data.error || 'Fout bij toevoegen');
      }
      
      toast('Toegevoegd aan wachtrij');
      setTitle('');
      setWebsite('');
      setValidationError(null);
      setShowWebsiteField(false);
      onSubmitted();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Fout bij toevoegen';
      toast(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-light)', background: 'var(--panel)' }}>
      <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em' }}>Nieuw onderwerp</div>
      
      <textarea
        value={title}
        onChange={e => {
          setTitle(e.target.value);
          setValidationError(null);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Naam van de zaak of het evenement…"
        rows={2}
        style={{
          marginTop: 12,
          width: '100%',
          border: validationError ? '1.5px solid var(--red)' : '1.5px solid var(--ink)',
          borderRadius: 12,
          background: 'var(--card)',
          padding: '14px 16px',
          fontSize: 15,
          fontWeight: 600,
          outline: 'none',
          resize: 'none',
        }}
      />
      
      {showWebsiteField && (
        <input
          type="url"
          value={website}
          onChange={e => {
            setWebsite(e.target.value);
            setValidationError(null);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="https://officielewebsite.nl"
          style={{
            marginTop: 8,
            width: '100%',
            border: validationError ? '1.5px solid var(--red)' : '1.5px solid var(--ink)',
            borderRadius: 12,
            background: 'var(--card)',
            padding: '14px 16px',
            fontSize: 15,
            fontWeight: 600,
            outline: 'none',
          }}
        />
      )}
      
      {validationError && (
        <div
          style={{
            marginTop: 10,
            padding: '12px 14px',
            background: 'var(--red-bg)',
            border: '1px solid var(--red-border)',
            borderRadius: 10,
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--red-dark)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {validationError}
        </div>
      )}
      
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          className="btn-primary"
          style={{ flex: 1, fontSize: 14, padding: 13, borderRadius: 10 }}
          disabled={!title.trim() || busy}
          onClick={submit}
        >
          {busy ? 'Bezig…' : 'Toevoegen aan wachtrij'}
        </button>
        <button
          className="btn"
          style={{ padding: '13px 14px', borderRadius: 10 }}
          onClick={onBulk}
          disabled={busy}
        >
          Plak lijst
        </button>
      </div>
      
      {!showWebsiteField && (
        <button
          className="btn-text"
          onClick={() => setShowWebsiteField(true)}
          style={{
            marginTop: 10,
            fontSize: 12,
            color: 'var(--blue)',
            fontWeight: 600,
            padding: 0,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          + Officiële website toevoegen (aanbevolen)
        </button>
      )}
      
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
        ✅ Gebruik de officiële website (bv. paradiso.nl, noartfestival.com)
        <br />
        ❌ Geen: city guides, ticketmaster, facebook, tripadvisor, timeout
      </div>
    </div>
  );
}
