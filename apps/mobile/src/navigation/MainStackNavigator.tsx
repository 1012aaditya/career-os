import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MainNavigator } from './MainNavigator';
import { ResumeImportScreen } from '../screens/main/ResumeImportScreen';
import ResumeReviewScreen from '../screens/ResumeReviewScreen';

const Stack = createNativeStackNavigator();

export function MainStackNavigator() {
  return (
    <Stack.Navigator>
      <Stack.Screen
        name="Tabs"
        component={MainNavigator}
        options={{ headerShown: false }}
      />

      <Stack.Screen
        name="ResumeImport"
        component={ResumeImportScreen}
        options={{ title: 'Import Resume' }}
      />

      <Stack.Screen
        name="ResumeReview"
        component={ResumeReviewScreen}
        options={{ title: 'Review Resume' }}
      />
    </Stack.Navigator>
  );
}
