import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MainNavigator } from './MainNavigator';
import { ResumeImportScreen } from '../screens/main/ResumeImportScreen';
import ResumeReviewScreen from '../screens/ResumeReviewScreen';
import { MarketPostingScreen } from '../screens/main/MarketPostingScreen';

const Stack = createNativeStackNavigator();

export function MainStackNavigator() {
  return (
    <Stack.Navigator>
      <Stack.Screen
        name="Tabs"
        component={MainNavigator}
        options={{ headerShown: false }}
      />

      {/* Job detail is pushed over the tabs, so the search results the
          reader came from are still there when they go back. */}
      <Stack.Screen
        name="MarketPosting"
        component={MarketPostingScreen}
        options={{ title: 'Job' }}
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
