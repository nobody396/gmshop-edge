# Independent invoice entry

VIP invoice requests stay on `/invoice`. Navigation and order links do not leave the storefront. The page calls the existing central public invoice API using its supported CORS policy, explicitly omitting credentials. VIP offline applications retain their source, and payment returns use laoshirenvip.com. lsrai.shop keeps its own page. No extra proxy, database, authentication system or notification pipeline is added.
