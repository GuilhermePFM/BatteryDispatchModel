import { contactEmail } from "../lib/config";

export function Privacy() {
  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>Privacy</h1>
          <p>Short, because very little is kept.</p>
        </div>
        <div className="prose privacy" style={{ marginTop: 24 }}>
          <h2>Signing in</h2>
          <p>
            Viewing the site needs no account. Running a plan does: you sign in with Google or LinkedIn through Amazon Cognito, which runs the sign-in on this
            site&apos;s behalf. The site never sees your password.
          </p>
          <h2>What is stored</h2>
          <ul>
            <li>Your account identifier (the &ldquo;sub&rdquo; Cognito issues) and your email address.</li>
            <li>A counter of how many runs you started today, to enforce the limit of three a day.</li>
            <li>The runs you start: the battery and dates you entered, any price file you uploaded, and the results.</li>
          </ul>
          <p>
            Your email only identifies your account. It is not shown to anyone, not used for marketing, and not shared with anyone. There are no analytics or
            advertising cookies; the browser keeps only what the sign-in needs for the current tab.
          </p>
          <h2>How long</h2>
          <p>
            Runs, their results and uploaded price files are deleted automatically 7 days after they are made. A run&apos;s link works for anyone who has it
            until then, so share it only if you are happy for others to see that run.
          </p>
          <h2>Your rights</h2>
          <p>
            Under the GDPR and Brazil&apos;s LGPD you can ask to see, correct or delete the data held about you, or object to its use. To ask, or to have your
            account and its data deleted, write to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>. The data is processed only to provide the service you
            asked for.
          </p>
        </div>
      </div>
    </div>
  );
}
