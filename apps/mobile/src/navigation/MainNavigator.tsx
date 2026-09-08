import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { CareerScreen } from '../screens/main/CareerScreen';
import { HomeScreen } from '../screens/main/HomeScreen';
import { MarketScreen } from '../screens/main/MarketScreen';
import { MarketSearchScreen } from '../screens/main/MarketSearchScreen';
import { OpportunitiesScreen } from '../screens/main/OpportunitiesScreen';
import { ProfileScreen } from '../screens/main/ProfileScreen';

const Tab = createBottomTabNavigator();

export function MainNavigator() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Career" component={CareerScreen} />
      {/*
        Search is the Market tab now, and the Phase 8 signals screen sits
        beside it. That ordering is the product claim: a reader opens the
        market to find jobs, not to read aggregate statistics about it.
      */}
      <Tab.Screen name="Market" component={MarketSearchScreen} />
      <Tab.Screen name="Signals" component={MarketScreen} />
      <Tab.Screen name="Opportunities" component={OpportunitiesScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}
