/** Always-visible header sign-in entry (BR#5581, Ray device feedback:
 *  "can't sign in"). In the shell the click dispatches the `bridge:sign-in`
 *  DOM event the shell INIT_SCRIPT listens for (shellui.rs: startSignIn →
 *  invoke shell_sign_in → <hub>/login?shell=1); in a plain browser — or in
 *  the shell with no hub url — it reveals the Connect card instead. */
export function SignInButton({ onSignIn }: { onSignIn: () => void }) {
  return (
    <button className="mb-signin" onClick={onSignIn}>
      Sign in
    </button>
  );
}
