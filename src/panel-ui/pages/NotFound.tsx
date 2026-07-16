import { Link, useLocation } from 'react-router-dom';
import { Compass } from 'lucide-react';

/**
 * Reached when the SPA fallback served index.html for a path react-router has no route for.
 * `location.pathname` is basename-stripped, so it is shown with /panel put back — otherwise it
 * would not match what is in the address bar.
 */
export function NotFound() {
  const location = useLocation();
  return (
    <div className="page">
      <div className="state">
        <Compass size={28} className="state-icon" aria-hidden />
        <div className="state-title">Page not found</div>
        <div className="state-msg">
          Nothing lives at <span className="mono">/panel{location.pathname}</span>.
        </div>
        <Link className="btn btn-sm" to="/games">
          Back to games
        </Link>
      </div>
    </div>
  );
}
