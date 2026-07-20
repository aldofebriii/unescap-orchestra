import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchDocumentDetail } from '../api';
import type { DocumentDetail } from '../types';
import styles from './DocumentDetailModal.module.css';

interface Props {
  jobId: string;
  title: string;
  onClose: () => void;
}

export default function DocumentDetailModal({ jobId, title, onClose }: Props) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'markdown' | 'provisions' | 'scores'>('markdown');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchDocumentDetail(jobId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {loading && (
          <div className={styles.loading}>
            <span className={styles.spinner} />
            Loading document detail…
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}

        {!loading && !error && detail && (
          <>
            <div className={styles.tabs}>
              <button
                type="button"
                className={`${styles.tab} ${activeTab === 'markdown' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('markdown')}
              >
                Markdown {detail.markdown ? `(${Math.round((detail.markdown.length / 1024)).toFixed(0)} KB)` : '(N/A)'}
              </button>
              <button
                type="button"
                className={`${styles.tab} ${activeTab === 'provisions' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('provisions')}
              >
                Provisions ({detail.provisions.length})
              </button>
              <button
                type="button"
                className={`${styles.tab} ${activeTab === 'scores' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('scores')}
              >
                Scores ({detail.scores.length})
              </button>
            </div>

            <div className={styles.content}>
              {activeTab === 'markdown' && (
                <div className={styles.markdown}>
                  {detail.markdown ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.markdown}</ReactMarkdown>
                  ) : (
                    <div className={styles.empty}>No markdown available for this document.</div>
                  )}
                </div>
              )}

              {activeTab === 'provisions' && (
                <div className={styles.provisions}>
                  {detail.provisions.length > 0 ? (
                    detail.provisions.map((p) => (
                      <div key={p.id} className={styles.provisionCard}>
                        <div className={styles.provisionHeader}>
                          <span className={styles.provisionAddress}>{p.address || 'No address'}</span>
                          <span className={styles.provisionLaw}>{p.lawNumber}</span>
                          {p.pillar && <span className={styles.provisionPillar}>Pillar {p.pillar}</span>}
                          {p.indicator && <span className={styles.provisionIndicator}>Ind. {p.indicator}</span>}
                          {p.flagForReview && <span className={styles.flagReview}>⚠️ Review</span>}
                        </div>
                        <div className={styles.provisionText}>{p.provisionText}</div>
                        {p.rationale && (
                          <div className={styles.provisionRationale}>
                            <strong>Rationale:</strong> {p.rationale}
                          </div>
                        )}
                        <div className={styles.provisionMeta}>
                          <span className={styles.metaTag}>{p.coverageType}</span>
                          {p.coverageSector && <span className={styles.metaTag}>{p.coverageSector}</span>}
                          {p.confidence != null && (
                            <span className={styles.metaTag}>
                              Confidence: {(p.confidence * 100).toFixed(0)}%
                            </span>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className={styles.empty}>No provisions extracted for this document.</div>
                  )}
                </div>
              )}

              {activeTab === 'scores' && (
                <div className={styles.scores}>
                  {detail.scores.length > 0 ? (
                    <>
                      {detail.regulation && detail.regulation.summary && (
                        <div className={styles.regulationSummary}>
                          <h3>Regulation Summary</h3>
                          <p>{detail.regulation.summary}</p>
                        </div>
                      )}
                      <div className={styles.scoresGrid}>
                        {detail.scores.map((s) => (
                          <div key={s.id} className={styles.scoreCard}>
                            <div className={styles.scoreHeader}>
                              <span className={styles.scoreIndicator}>
                                {s.indicatorId} {s.indicatorName && `— ${s.indicatorName}`}
                              </span>
                              {s.score != null && (
                                <span
                                  className={`${styles.scoreValue} ${
                                    !s.isValid ? styles.scoreInvalid : ''
                                  }`}
                                >
                                  {s.score}
                                </span>
                              )}
                            </div>
                            {s.justification && (
                              <div className={styles.scoreJustification}>{s.justification}</div>
                            )}
                            {s.keyEvidence.length > 0 && (
                              <div className={styles.scoreEvidence}>
                                <strong>Evidence:</strong>
                                <ul>
                                  {s.keyEvidence.map((e, i) => (
                                    <li key={i}>{e}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {s.validationIssues.length > 0 && (
                              <div className={styles.scoreIssues}>
                                <strong>⚠️ Validation Issues:</strong>
                                <ul>
                                  {s.validationIssues.map((issue, i) => (
                                    <li key={i}>{issue}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div className={styles.scoreMeta}>
                              {s.confidence != null && (
                                <span className={styles.metaTag}>
                                  Confidence: {(s.confidence * 100).toFixed(0)}%
                                </span>
                              )}
                              {s.referenceScore != null && (
                                <span className={styles.metaTag}>
                                  Ref: {s.referenceScore} {s.referenceMatch ? '✓' : '✗'}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className={styles.empty}>No scores available for this document.</div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
