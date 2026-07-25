import { prisma } from "../db.js";

export type Restaurant = {
  id: number;
  restaurantName: string;
  restaurantCity: string;
  ownerNumbers: string;
  isActive: boolean;
};

export async function getActiveRestaurant(): Promise<Restaurant> {
  const r = await prisma.restaurantConfig.findFirst({ where: { isActive: true } });
  if (!r) throw new Error("No active restaurant found in RestaurantConfig — run: npm run db:seed");
  return r;
}
