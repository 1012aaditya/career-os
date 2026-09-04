import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useAuth } from '../auth/AuthProvider';
import { SignInScreen } from '../screens/auth/SignInScreen';
import { MainNavigator } from './MainNavigator';

const Stack = createNativeStackNavigator();

export function RootNavigator() {
  const { session, loading } = useAuth();

  if (loading) {
    return null;
  }

  return (
    <NavigationContainer>
      <Stack.Navigator>
        {session ? (
          <Stack.Screen
            name="Main"
            component={MainNavigator}
            options={{ headerShown: false }}
          />
        ) : (
          <Stack.Screen
            name="SignIn"
            component={SignInScreen}
            options={{ title: 'Sign In' }}
          />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
