import { menuAsInteractiveCarouselCards } from "../services/menu.js";

async function main() {
  const cards = await menuAsInteractiveCarouselCards(1);
  console.log("Number of cards:", cards.length);
}

main().catch(console.error);
