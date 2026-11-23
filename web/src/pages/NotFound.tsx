import { Link } from "react-router";
import { useI18n } from "../i18n";

export function NotFound() {
  const t = useI18n().t.notFound;
  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>{t.title}</h1>
          <p>{t.text}</p>
        </div>
        <div className="actions" style={{ marginTop: 24 }}>
          <Link className="btn btn-primary" to="/">
            {t.back}
          </Link>
          <Link className="btn btn-secondary" to="/run">
            {t.run}
          </Link>
        </div>
      </div>
    </div>
  );
}
