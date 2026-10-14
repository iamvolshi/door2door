import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  FlatList,
  Linking,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, ApiError, newIdempotencyKey, rememberOrderId, savedOrderIds } from './src/api';
import { AuthProvider, useAuth } from './src/auth';

type CartLine = { item: any; qty: number };

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429 && e.retryAfter) return `Too many tries — wait ${e.retryAfter}s and try again.`;
    return e.message;
  }
  return 'Something went wrong. Check your connection.';
}

function PhoneScreen({ onSent }: { onSent: (phone: string, devOtp?: string) => void }) {
  const { requestOtp } = useAuth();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, setWait] = useState<number | null>(null);

  async function send() {
    setBusy(true);
    setError('');
    try {
      const res = await requestOtp(phone.trim());
      if (res.retryAfter) {
        setWait(res.retryAfter);
      } else {
        onSent(phone.trim(), res.devOtp);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.screen}>
      <Text style={s.title}>Cox's Bazar Door2Door</Text>
      <Text style={s.sub}>Enter your mobile number to sign in.</Text>
      <TextInput style={s.input} placeholder="+8801XXXXXXXXX" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
      {wait !== null && <Text style={s.note}>Please wait {wait}s before requesting a new code.</Text>}
      {error !== '' && <Text style={s.error}>{error}</Text>}
      {busy ? <ActivityIndicator /> : <Button title="Send code" onPress={send} />}
    </View>
  );
}

function CodeScreen({ phone, devOtp, onDone }: { phone: string; devOtp?: string; onDone: (otp: string) => void }) {
  const { verifyOtp } = useAuth();
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const res = await verifyOtp(phone, otp.trim());
      if (res.registrationRequired) {
        onDone(otp.trim());
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.screen}>
      <Text style={s.title}>Enter the code</Text>
      <Text style={s.sub}>Sent to {phone}.</Text>
      {devOtp ? <Text style={s.note}>Test build code: {devOtp}</Text> : null}
      <TextInput style={s.input} placeholder="6-digit code" keyboardType="number-pad" value={otp} onChangeText={setOtp} />
      {error !== '' && <Text style={s.error}>{error}</Text>}
      {busy ? <ActivityIndicator /> : <Button title="Confirm" onPress={confirm} />}
    </View>
  );
}

function RegisterScreen({ phone, otp }: { phone: string; otp: string }) {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    setBusy(true);
    setError('');
    try {
      await register(phone, otp, name.trim());
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.screen}>
      <Text style={s.title}>One last step</Text>
      <Text style={s.sub}>What should we call you?</Text>
      <TextInput style={s.input} placeholder="Full name" value={name} onChangeText={setName} />
      {error !== '' && <Text style={s.error}>{error}</Text>}
      {busy ? <ActivityIndicator /> : <Button title="Create account" onPress={go} />}
    </View>
  );
}

function HomeScreen({ onOpen, onOrders }: { onOpen: (m: any) => void; onOrders: () => void }) {
  const { user, logout } = useAuth();
  const [stores, setStores] = useState<any[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/merchants', false)
      .then((d) => setStores(d.merchants ?? []))
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  }, []);

  return (
    <View style={s.screen}>
      <Text style={s.title}>Hi {user?.fullName ?? 'there'} 👋</Text>
      <Text style={s.sub}>Where to order from today?</Text>
      {busy && <ActivityIndicator />}
      {error !== '' && <Text style={s.error}>{error}</Text>}
      <FlatList
        data={stores}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={s.card}>
            <Text style={s.cardTitle}>{item.businessName}</Text>
            <Text style={s.sub}>
              {item.category} · ⭐ {item.rating} · {item.isOpen ? 'Open' : 'Closed'}
            </Text>
            <Button title="View menu" disabled={!item.isOpen} onPress={() => onOpen(item)} />
          </View>
        )}
      />
      <View style={s.row}>
        <Button title="My orders" onPress={onOrders} />
        <Button title="Sign out" onPress={logout} />
      </View>
    </View>
  );
}

function MenuScreen({
  merchant,
  cart,
  onAdd,
  onCheckout,
  onBack,
}: {
  merchant: any;
  cart: CartLine[];
  onAdd: (item: any) => void;
  onCheckout: () => void;
  onBack: () => void;
}) {
  const [items, setItems] = useState<any[]>([]);
  const [busy, setBusy] = useState(true);
  const count = cart.reduce((n, l) => n + l.qty, 0);

  useEffect(() => {
    api
      .get(`/merchants/${merchant.id}/menu`, false)
      .then((d) => setItems((d.items ?? []).filter((i: any) => i.isAvailable)))
      .catch(() => setItems([]))
      .finally(() => setBusy(false));
  }, [merchant.id]);

  return (
    <View style={s.screen}>
      <Text style={s.title}>{merchant.businessName}</Text>
      {busy && <ActivityIndicator />}
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => (
          <View style={s.card}>
            <Text style={s.cardTitle}>{item.name}</Text>
            <Text style={s.sub}>{item.description}</Text>
            <Text style={s.price}>৳{item.priceBdt}</Text>
            <Button title="Add" onPress={() => onAdd(item)} />
          </View>
        )}
      />
      <View style={s.row}>
        <Button title="Back" onPress={onBack} />
        <Button title={`Checkout (${count})`} disabled={count === 0} onPress={onCheckout} />
      </View>
    </View>
  );
}

function CheckoutScreen({
  merchant,
  cart,
  onPlaced,
  onBack,
}: {
  merchant: any;
  cart: CartLine[];
  onPlaced: (orderId: string) => void;
  onBack: () => void;
}) {
  const [street, setStreet] = useState('');
  const [area, setArea] = useState('');
  const [district, setDistrict] = useState("Cox's Bazar");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState('');
  const total = cart.reduce((n, l) => n + l.qty * l.item.priceBdt, 0);

  async function place() {
    setBusy(true);
    setError('');
    try {
      setStep('Saving your address…');
      const saved = await api.get('/addresses');
      let addressId: string | null = saved.addresses?.[0]?.id ?? null;
      if (!addressId) {
        const created = await api.post('/addresses', {
          label: 'Home',
          streetAddress: street.trim(),
          area: area.trim(),
          district: district.trim(),
        });
        addressId = created.address.id;
      }
      const body = {
        merchantId: merchant.id,
        items: cart.map((l) => ({ itemId: l.item.id, quantity: l.qty })),
        serviceArea: 'cox_bazar_sadar',
        distanceKm: 2,
        deliveryAddressId: addressId,
      };
      setStep('Confirming your order…');
      const placed = await api.post('/orders', body, { idempotencyKey: newIdempotencyKey() });
      const orderId: string = placed.order.id;
      await rememberOrderId(orderId);
      setStep('Recording cash on delivery…');
      await api.post(
        `/orders/${orderId}/payments`,
        { method: 'CASH_ON_DELIVERY' },
        { idempotencyKey: newIdempotencyKey() }
      );
      onPlaced(orderId);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setStep('');
    }
  }

  return (
    <View style={s.screen}>
      <Text style={s.title}>Checkout</Text>
      <Text style={s.sub}>
        {merchant.businessName} · {cart.reduce((n, l) => n + l.qty, 0)} items · ≈৳{total}
      </Text>
      <Text style={s.sub}>Deliver to (first order only — we remember it after):</Text>
      <TextInput style={s.input} placeholder="Street address" value={street} onChangeText={setStreet} />
      <TextInput style={s.input} placeholder="Area (e.g. Kolatoli)" value={area} onChangeText={setArea} />
      <TextInput style={s.input} placeholder="District" value={district} onChangeText={setDistrict} />
      {error !== '' && <Text style={s.error}>{error}</Text>}
      {step !== '' && <Text style={s.note}>{step}</Text>}
      {busy ? (
        <ActivityIndicator />
      ) : (
        <View style={s.row}>
          <Button title="Back" onPress={onBack} />
          <Button title="Place order · Cash" onPress={place} />
        </View>
      )}
    </View>
  );
}

function TrackScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [order, setOrder] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .get(`/orders/${orderId}`)
        .then((d) => live && setOrder(d.order))
        .catch((e) => live && setError(errText(e)));
    load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [orderId]);

  return (
    <View style={s.screen}>
      <Text style={s.title}>Order {order?.orderNumber ?? '…'}</Text>
      {error !== '' && <Text style={s.error}>{error}</Text>}
      {order ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>Status: {order.status}</Text>
          <Text style={s.sub}>Total: ৳{order.pricing?.totalBdt}</Text>
          {(order.items ?? []).map((i: any, idx: number) => (
            <Text key={i.itemId ?? idx} style={s.sub}>
              {i.quantity}× {i.name}
            </Text>
          ))}
        </View>
      ) : (
        <ActivityIndicator />
      )}
      <Button title="Back" onPress={onBack} />
    </View>
  );
}

function OrdersScreen({ onTrack, onBack }: { onTrack: (id: string) => void; onBack: () => void }) {
  const [rows, setRows] = useState<{ id: string; status: string }[]>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    (async () => {
      const ids = await savedOrderIds();
      const out: { id: string; status: string }[] = [];
      for (const id of ids) {
        try {
          const d = await api.get(`/orders/${id}`);
          out.push({ id, status: d.order.status });
        } catch {
          out.push({ id, status: 'unknown' });
        }
      }
      setRows(out);
      setBusy(false);
    })();
  }, []);

  return (
    <View style={s.screen}>
      <Text style={s.title}>My orders</Text>
      {busy && <ActivityIndicator />}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <View style={s.card}>
            <Text style={s.cardTitle}>{item.id}</Text>
            <Text style={s.sub}>Status: {item.status}</Text>
            <Button title="Track" onPress={() => onTrack(item.id)} />
          </View>
        )}
      />
      <Button title="Back" onPress={onBack} />
    </View>
  );
}

type Screen =
  | { name: 'phone' }
  | { name: 'code'; phone: string; devOtp?: string }
  | { name: 'register'; phone: string; otp: string }
  | { name: 'home' }
  | { name: 'menu'; merchant: any }
  | { name: 'checkout' }
  | { name: 'orders' }
  | { name: 'track'; orderId: string };

function Shell() {
  const { ready, user } = useAuth();
  const [screen, setScreen] = useState<Screen>({ name: 'phone' });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [merchant, setMerchant] = useState<any>(null);

  // A fresh sign-in always lands on home, whatever auth screen was showing.
  useEffect(() => {
    if (user && (screen.name === 'phone' || screen.name === 'code' || screen.name === 'register')) {
      setScreen({ name: 'home' });
    }
    if (!user) {
      setCart([]);
      setMerchant(null);
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return (
      <View style={s.screen}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  function addToCart(item: any) {
    setCart((prev) => {
      const found = prev.find((l) => l.item.id === item.id);
      if (found) {
        return prev.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, { item, qty: 1 }];
    });
  }

  function openMerchant(m: any) {
    setMerchant(m);
    setCart([]);
    setScreen({ name: 'menu', merchant: m });
  }

  let body: React.ReactNode;
  if (!user) {
    if (screen.name === 'code') {
      body = (
        <CodeScreen
          phone={screen.phone}
          devOtp={screen.devOtp}
          onDone={(otp) => setScreen({ name: 'register', phone: screen.phone, otp })}
        />
      );
    } else if (screen.name === 'register') {
      body = <RegisterScreen phone={screen.phone} otp={screen.otp} />;
    } else {
      body = (
        <PhoneScreen onSent={(phone, devOtp) => setScreen({ name: 'code', phone, devOtp })} />
      );
    }
  } else if (screen.name === 'menu' && merchant) {
    body = (
      <MenuScreen
        merchant={merchant}
        cart={cart}
        onAdd={addToCart}
        onCheckout={() => setScreen({ name: 'checkout' })}
        onBack={() => setScreen({ name: 'home' })}
      />
    );
  } else if (screen.name === 'checkout' && merchant) {
    body = (
      <CheckoutScreen
        merchant={merchant}
        cart={cart}
        onPlaced={(orderId) => {
          setCart([]);
          setScreen({ name: 'track', orderId });
        }}
        onBack={() => setScreen({ name: 'menu', merchant })}
      />
    );
  } else if (screen.name === 'orders') {
    body = (
      <OrdersScreen
        onTrack={(orderId) => setScreen({ name: 'track', orderId })}
        onBack={() => setScreen({ name: 'home' })}
      />
    );
  } else if (screen.name === 'track') {
    body = <TrackScreen orderId={screen.orderId} onBack={() => setScreen({ name: 'orders' })} />;
  } else {
    body = <HomeScreen onOpen={openMerchant} onOrders={() => setScreen({ name: 'orders' })} />;
  }

  return (
    <SafeAreaView style={s.root}>
      {body}
      <View style={s.footer}>
        <Text style={s.footerText}>
          a{' '}
          <Text style={s.footerLink} onPress={() => Linking.openURL('https://volshi.com')}>
            VOLSHi
          </Text>{' '}
          product
        </Text>
      </View>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  screen: { flex: 1, padding: 20, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  sub: { fontSize: 14, color: '#555' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  error: { color: '#b00020' },
  note: { color: '#1a73e8' },
  card: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    gap: 6,
  },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  price: { fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  footer: { alignItems: 'center', paddingVertical: 8 },
  footerText: { fontSize: 11, color: '#999' },
  footerLink: { fontSize: 11, color: '#999', textDecorationLine: 'underline' },
});
