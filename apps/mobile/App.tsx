import { AuthProvider } from './src/auth/AuthProvider';
import { GithubConnectionProvider } from './src/github/GithubConnectionProvider';
import { RootNavigator } from './src/navigation/RootNavigator';

/*
 * The GitHub provider sits ABOVE navigation, not inside a screen.
 *
 * The OAuth callback arrives as a deep link, and a cold start FROM that
 * link renders no screen until the OS delivers the URL. Handling it in
 * the Profile screen's effect would miss exactly that case, and the user
 * would return from GitHub to an app that still said "Not connected". It
 * is inside AuthProvider because it needs the session to call the API.
 */
export default function App() {
  return (
    <AuthProvider>
      <GithubConnectionProvider>
        <RootNavigator />
      </GithubConnectionProvider>
    </AuthProvider>
  );
}
