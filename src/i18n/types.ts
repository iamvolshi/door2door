export type SupportedLocale = 'bn' | 'en';

export interface CommonDictionary {
  appName: string;
  tagline: string;
  loading: string;
  error: string;
  retry: string;
  cancel: string;
  confirm: string;
  save: string;
  search: string;
  back: string;
  next: string;
  currencySymbol: string;
  currencyCode: string;
  networkErrorLowBandwidth: string;
}

export interface CatalogDictionary {
  categories: string;
  allRestaurants: string;
  groceriesAndFresh: string;
  pharmacy: string;
  searchPlaceholder: string;
  addToCart: string;
  itemAdded: string;
  outOfStock: string;
  estimatedDeliveryTime: string;
  pricePerUnit: string;
  ratings: string;
  reviewsCount: string;
  filterByRating: string;
  sortByDistance: string;
  sortByPrice: string;
  popularInCoxsBazar: string;
}

export interface CheckoutDictionary {
  cartTitle: string;
  emptyCartMessage: string;
  subtotal: string;
  deliveryFee: string;
  serviceCharge: string;
  taxVat: string;
  discount: string;
  totalAmount: string;
  deliveryAddress: string;
  changeAddress: string;
  deliveryNotesPlaceholder: string;
  paymentMethod: string;
  cashOnDelivery: string;
  bKash: string;
  nagad: string;
  placeOrder: string;
  processingPayment: string;
  orderSuccessTitle: string;
  minimumOrderNotice: string;
}

export interface OrderTrackingDictionary {
  trackOrderTitle: string;
  orderId: string;
  orderPlaced: string;
  orderConfirmed: string;
  kitchenPreparing: string;
  riderAssigned: string;
  outForDelivery: string;
  delivered: string;
  cancelled: string;
  liveMapTracking: string;
  riderName: string;
  riderPhone: string;
  callRider: string;
  supportAssistance: string;
  estimatedArrival: string;
  etaMinutes: string;
}

export interface SupportDictionary {
  helpCenterTitle: string;
  faq: string;
  liveChat: string;
  callSupport: string;
  emergencyHotline: string;
  createTicket: string;
  ticketSubject: string;
  ticketDescription: string;
  ticketCreatedSuccess: string;
  frequentlyAskedQuestions: string;
  refundPolicy: string;
  safetyGuidelines: string;
  coxBazarDeskHours: string;
}

export interface TranslationDictionary {
  common: CommonDictionary;
  catalog: CatalogDictionary;
  checkout: CheckoutDictionary;
  orderTracking: OrderTrackingDictionary;
  support: SupportDictionary;
}

export type TranslationNamespace = keyof TranslationDictionary;