// Who is signed in, and whose workspace an admin is currently working in.

const ACT_AS_KEY = 'ia.actAs';

export const session = {
  me: null, // the signed-in account
  actAs: null, // { id, name } when an admin has opened another user's workspace
};

export const isAdmin = () => session.me?.role === 'admin';

export function restoreActAs() {
  try {
    session.actAs = JSON.parse(sessionStorage.getItem(ACT_AS_KEY) || 'null');
  } catch {
    session.actAs = null;
  }
  if (!isAdmin()) session.actAs = null;
}

export function setActAs(user) {
  session.actAs = user ? { id: user.id, name: user.name } : null;
  try {
    if (session.actAs) sessionStorage.setItem(ACT_AS_KEY, JSON.stringify(session.actAs));
    else sessionStorage.removeItem(ACT_AS_KEY);
  } catch {
    /* storage unavailable: it just is not remembered across reloads */
  }
}
