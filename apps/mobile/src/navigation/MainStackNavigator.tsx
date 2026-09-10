import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MainNavigator } from './MainNavigator';
import { ResumeImportScreen } from '../screens/main/ResumeImportScreen';
import ResumeReviewScreen from '../screens/ResumeReviewScreen';
import { MarketPostingScreen } from '../screens/main/MarketPostingScreen';
import { AddEvidenceScreen } from '../screens/main/evidence/AddEvidenceScreen';
import { AllEvidenceScreen } from '../screens/main/evidence/AllEvidenceScreen';
import { EvidenceDetailScreen } from '../screens/main/evidence/EvidenceDetailScreen';
import { EvidenceHomeScreen } from '../screens/main/evidence/EvidenceHomeScreen';
import { SourceDetailScreen } from '../screens/main/evidence/SourceDetailScreen';
import { SourcesScreen } from '../screens/main/evidence/SourcesScreen';

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

      {/* The Evidence layer, reached from Career rather than from a tab of
          its own - it is infrastructure underneath the career graph, not a
          seventh destination competing with it. */}
      <Stack.Screen
        name="Evidence"
        component={EvidenceHomeScreen}
        options={{ title: 'Evidence' }}
      />

      <Stack.Screen
        name="AllEvidence"
        component={AllEvidenceScreen}
        options={{ title: 'All Evidence' }}
      />

      <Stack.Screen
        name="EvidenceDetail"
        component={EvidenceDetailScreen}
        options={{ title: 'Evidence' }}
      />

      <Stack.Screen
        name="EvidenceSources"
        component={SourcesScreen}
        options={{ title: 'Sources' }}
      />

      <Stack.Screen
        name="EvidenceSourceDetail"
        component={SourceDetailScreen}
        options={{ title: 'Source' }}
      />

      <Stack.Screen
        name="AddEvidence"
        component={AddEvidenceScreen}
        options={{ title: 'Add Evidence' }}
      />
    </Stack.Navigator>
  );
}
