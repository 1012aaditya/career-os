import { AuthProvider } from './src/auth/AuthProvider';
import { RootNavigator } from './src/navigation/RootNavigator';

export default function App() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
