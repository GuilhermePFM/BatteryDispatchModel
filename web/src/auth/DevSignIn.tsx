import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthProvider";

/** Development sign-in: any name and email, sent to the API as Bearer dev:<sub>:<email>. */
export function DevSignIn() {
  const { devDialogOpen, closeDevDialog, devSignIn } = useAuth();
  const t = useI18n().t.auth;
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("Ada Lovelace");
  const [email, setEmail] = useState("ada@example.com");
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (devDialogOpen && !dialog.open) dialog.showModal();
    if (!devDialogOpen && dialog.open) dialog.close();
  }, [devDialogOpen]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const returnTo = devSignIn(name.trim(), email.trim());
    if (returnTo) navigate(returnTo);
  }

  return (
    <dialog ref={ref} className="modal" onClose={closeDevDialog} aria-labelledby="dev-title">
      <form onSubmit={submit}>
        <div>
          <h2 id="dev-title" style={{ fontSize: "1.25rem" }}>
            {t.devTitle}
          </h2>
          <p className="help" style={{ marginTop: 6 }}>
            {t.devNote}
          </p>
        </div>
        <div className="field">
          <label htmlFor="dev-name">{t.name}</label>
          <input id="dev-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
        <div className="field">
          <label htmlFor="dev-email">{t.email}</label>
          <input
            id="dev-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            aria-invalid={valid ? undefined : true}
          />
        </div>
        <div className="actions" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-quiet" onClick={closeDevDialog}>
            {t.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>
            {t.signIn}
          </button>
        </div>
      </form>
    </dialog>
  );
}
