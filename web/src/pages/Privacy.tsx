import { useI18n } from "../i18n";
import { Rich } from "../i18n/Rich";
import { contactEmail } from "../lib/config";

export function Privacy() {
  const t = useI18n().t.privacy;
  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>{t.title}</h1>
          <p>{t.lede}</p>
        </div>
        <div className="prose privacy" style={{ marginTop: 24 }}>
          <h2>{t.signingTitle}</h2>
          <p>{t.signing}</p>
          <h2>{t.storedTitle}</h2>
          <ul>
            {t.stored.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>{t.email}</p>
          <h2>{t.howLongTitle}</h2>
          <p>{t.howLong}</p>
          <h2>{t.rightsTitle}</h2>
          <p>
            <Rich text={t.rights} tags={{ email: () => <a href={`mailto:${contactEmail}`}>{contactEmail}</a> }} />
          </p>
        </div>
      </div>
    </div>
  );
}
