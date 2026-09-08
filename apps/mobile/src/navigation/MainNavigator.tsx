import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { CareerScreen } from '../screens/main/CareerScreen';
import { HomeScreen } from '../screens/main/HomeScreen';
import { MarketScreen } from '../screens/main/MarketScreen';
import { OpportunitiesScreen } from '../screens/main/OpportunitiesScreen';
import { ProfileScreen } from '../screens/main/ProfileScreen';

const Tab = createBottomTabNavigator();

export function MainNavigator() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Career" component={CareerScreen} />
      <Tab.Screen name="Market" component={MarketScreen} />
      <Tab.Screen name="Opportunities" component={OpportunitiesScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}
