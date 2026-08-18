export function SignOutButton({ className = "button secondary" }: { className?: string }) {
  return (
    <form action="/auth/signout" method="post">
      <button className={className} type="submit">
        Sign out
      </button>
    </form>
  );
}
