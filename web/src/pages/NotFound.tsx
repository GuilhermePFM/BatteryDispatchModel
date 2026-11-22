import { Link } from "react-router";

export function NotFound() {
  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>Nothing here</h1>
          <p>This address does not match a page. Run links stay valid for 7 days.</p>
        </div>
        <div className="actions" style={{ marginTop: 24 }}>
          <Link className="btn btn-primary" to="/">
            Back to the results
          </Link>
          <Link className="btn btn-secondary" to="/run">
            Run your own
          </Link>
        </div>
      </div>
    </div>
  );
}
